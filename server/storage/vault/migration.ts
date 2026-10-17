import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ChangeRecord } from "../types.js";
import { STATE_FILE, STATE_FORMAT, STATE_VERSION, MAX_VAULT_FILE_BYTES, UUID_PATTERN } from "./constants.js";
import { VaultStorageError } from "./errors.js";
import {
  normalizedNameKey,
  normalizedRelativeKey,
  relativePath,
  parentPath,
  basename,
  safeNoteFileName,
  safeFolderSegment,
} from "./paths.js";
import { hashBytes, fileKey, fsyncDirectory, writeAtomic, writeNewDurable } from "./files.js";
import { isTimestamp } from "./manifest.js";
import type {
  VaultDocumentMeta,
  VaultTrashMeta,
  VaultFolderMeta,
  VaultState,
  LegacyDocument,
  LegacyTrashedDocument,
  LegacyFolder,
} from "./types.js";

export function createVaultFromLegacy(
  root: string,
  documents: LegacyDocument[],
  folders: LegacyFolder[],
  changes: ChangeRecord[],
  migrationManifestPath: string,
  trashedDocuments: LegacyTrashedDocument[] = [],
): { vaultId: string; documentCount: number; folderCount: number; sequence: number } {
  const destination = path.resolve(root);
  if (existsSync(destination)) throw new VaultStorageError("Migration destination must not already exist.", "vault_destination_exists", 409);
  if (Buffer.byteLength(destination, "utf8") > 900) throw new VaultStorageError("Migration destination exceeds the portable 900-byte path limit.", "vault_migration_invalid", 409);
  const parent = path.dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `.${path.basename(destination)}.staging-${randomUUID()}`);
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  const resolvedManifest = path.resolve(migrationManifestPath);
  let manifestCreated = false;
  try {
  if (existsSync(resolvedManifest)) throw new VaultStorageError("Migration manifest already exists; refusing to overwrite it.", "vault_manifest_exists", 409);
  if (new Set(documents.map((document) => document.id)).size !== documents.length
    || new Set(folders.map((folder) => folder.id)).size !== folders.length
    || new Set([...documents, ...trashedDocuments].map((document) => document.id)).size !== documents.length + trashedDocuments.length
    || new Set(trashedDocuments.map((document) => document.id)).size !== trashedDocuments.length) {
    throw new VaultStorageError("Legacy storage contains duplicate stable IDs.", "vault_migration_invalid", 409);
  }
  const metadata = path.join(staging, ".fieldnotes");
  mkdirSync(metadata, { recursive: false, mode: 0o700 });

  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const folderPaths = new Map<string, string>();
  const folderMetas: VaultFolderMeta[] = [];
  const sortedFolders = [...folders].sort((left, right) => {
    const depth = (folder: LegacyFolder): number => {
      let count = 0;
      let current: LegacyFolder | undefined = folder;
      const seen = new Set<string>();
      while (current?.parentId) {
        if (seen.has(current.id)) throw new VaultStorageError("Legacy folder hierarchy contains a cycle.", "vault_migration_invalid", 409);
        seen.add(current.id);
        count += 1;
        current = foldersById.get(current.parentId);
      }
      return count;
    };
    return depth(left) - depth(right) || left.id.localeCompare(right.id);
  });
  for (const folder of sortedFolders) {
    const parentRelative = folder.parentId ? folderPaths.get(folder.parentId) : "";
    if (folder.parentId && parentRelative === undefined) throw new VaultStorageError("Legacy folder references a missing parent.", "vault_migration_invalid", 409);
    const raw = folder.name.normalize("NFC");
    let safe = safeFolderSegment(raw, folder.id);
    const siblingNames = folderMetas.filter((item) => parentRelative ? item.relativePath.startsWith(`${parentRelative}/`) && parentPath(item.relativePath) === parentRelative : parentPath(item.relativePath) === "").map((item) => basename(item.relativePath));
    if (siblingNames.some((name) => normalizedNameKey(name) === normalizedNameKey(safe))) {
      safe = safeFolderSegment(raw, folder.id, true);
    }
    const rel = relativePath(parentRelative ?? "", safe);
    if (Buffer.byteLength(safe, "utf8") > 240) throw new VaultStorageError("A folder path component exceeds the portable filesystem limit.", "vault_migration_invalid", 409);
    if (Buffer.byteLength(path.join(staging, ...rel.split("/")), "utf8") > 900) throw new VaultStorageError("A folder path exceeds the portable 900-byte filesystem limit.", "vault_migration_invalid", 409);
    mkdirSync(path.join(staging, ...rel.split("/")), { recursive: true, mode: 0o700 });
    fsyncDirectory(path.dirname(path.join(staging, ...rel.split("/"))));
    const key = fileKey(path.join(staging, ...rel.split("/")));
    folderPaths.set(folder.id, rel);
    folderMetas.push({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      relativePath: rel,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
      version: folder.version,
      ...key,
    });
  }

  const usedPaths = new Set<string>(folderMetas.map((folder) => normalizedRelativeKey(folder.relativePath)));
  const documentMetas: VaultDocumentMeta[] = [];
  const trashMetas: VaultTrashMeta[] = [];
  const migrationDocuments: Array<{ id: string; title: string; folderId: string | null; relativePath: string; contentHash: string }> = [];
  const sortedDocuments = [...documents].sort((left, right) => left.id.localeCompare(right.id));
  for (const document of sortedDocuments) {
    const parentRelative = document.folderId ? folderPaths.get(document.folderId) : "";
    if (document.folderId && parentRelative === undefined) throw new VaultStorageError("Legacy note references a missing folder.", "vault_migration_invalid", 409);
    const parentAbsolute = path.join(staging, ...(parentRelative ? parentRelative.split("/") : []));
    const plainName = safeNoteFileName(document.title, document.id);
    const collision = usedPaths.has(normalizedRelativeKey(relativePath(parentRelative ?? "", plainName)));
    const fileName = collision ? safeNoteFileName(document.title, document.id, true) : plainName;
    const rel = relativePath(parentRelative ?? "", fileName);
    const key = normalizedRelativeKey(rel);
    if (usedPaths.has(key)) throw new VaultStorageError("Legacy notes map to the same filesystem name even with stable-ID suffixes.", "vault_migration_collision", 409);
    usedPaths.add(key);
    const absolute = path.join(parentAbsolute, fileName);
    if (Buffer.byteLength(absolute, "utf8") > 900) throw new VaultStorageError("A note path exceeds the portable 900-byte filesystem limit.", "vault_migration_invalid", 409);
    const bytes = Buffer.from(document.body, "utf8");
    if (bytes.byteLength > MAX_VAULT_FILE_BYTES) throw new VaultStorageError(`Legacy note ${document.id} exceeds the vault file size limit.`, "vault_migration_invalid", 409);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(absolute, "wx", 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      fsyncDirectory(path.dirname(absolute));
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error;
    }
    const hash = hashBytes(bytes);
    const fileKeyValue = fileKey(absolute);
    const meta: VaultDocumentMeta = {
      id: document.id,
      title: document.title,
      folderId: document.folderId,
      relativePath: rel,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      version: document.version,
      contentHash: hash,
      ...fileKeyValue,
    };
    documentMetas.push(meta);
    migrationDocuments.push({ id: document.id, title: document.title, folderId: document.folderId, relativePath: rel, contentHash: hash });
  }
  for (const document of documents) {
    const meta = documentMetas.find((item) => item.id === document.id);
    if (!meta) throw new VaultStorageError("Migration omitted a legacy note.", "vault_migration_invalid", 409);
    const roundtrip = readFileSync(path.join(staging, ...meta.relativePath.split("/")), "utf8");
    if (roundtrip !== document.body) throw new VaultStorageError(`Markdown roundtrip failed for legacy note ${document.id}.`, "vault_migration_invalid", 409);
  }

  if (trashedDocuments.length) mkdirSync(path.join(metadata, "trash"), { recursive: false, mode: 0o700 });
  for (const document of trashedDocuments) {
    if (!UUID_PATTERN.test(document.id) || !document.title.trim() || document.title.length > 160
      || !isTimestamp(document.createdAt) || !isTimestamp(document.updatedAt) || !isTimestamp(document.trashedAt)
      || !Number.isSafeInteger(document.version) || document.version < 1) {
      throw new VaultStorageError("A trashed legacy note has invalid metadata.", "vault_migration_invalid", 409);
    }
    const bytes = Buffer.from(document.body, "utf8");
    if (document.body.length > 250_000 || bytes.byteLength > MAX_VAULT_FILE_BYTES) {
      throw new VaultStorageError(`Trashed legacy note ${document.id} exceeds the vault file limit.`, "vault_migration_invalid", 409);
    }
    const trashPath = `.fieldnotes/trash/${document.id}.md`;
    const absolute = path.join(metadata, "trash", `${document.id}.md`);
    writeNewDurable(absolute, bytes);
    fsyncDirectory(path.dirname(absolute));
    const parentRelative = document.folderId ? folderPaths.get(document.folderId) : "";
    const relativeName = relativePath(parentRelative ?? "", safeNoteFileName(document.title, document.id, true));
    const contentHash = hashBytes(bytes);
    const meta: VaultTrashMeta = {
      id: document.id,
      title: document.title,
      folderId: document.folderId,
      relativePath: relativeName,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      version: document.version,
      contentHash,
      trashPath,
      trashedAt: document.trashedAt,
      ...fileKey(absolute),
    };
    trashMetas.push(meta);
  }

  const vaultId = randomUUID();
  const sequence = changes.reduce((maximum, change) => Math.max(maximum, change.seq), 0);
  const state: VaultState = {
    format: STATE_FORMAT,
    schemaVersion: STATE_VERSION,
    vaultId,
    sequence,
    documents: documentMetas,
    trashedDocuments: trashMetas,
    folders: folderMetas,
    changes: [...changes].sort((left, right) => left.seq - right.seq),
  };
  writeAtomic(path.join(metadata, STATE_FILE), Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8"));
  fsyncDirectory(staging);
  const manifest = {
    format: "fieldnotes-migration-manifest",
    createdAt: new Date().toISOString(),
    vaultId,
    sourceCounts: { documents: documents.length, trashedDocuments: trashedDocuments.length, folders: folders.length, changes: changes.length },
    documents: migrationDocuments,
    trashedDocuments: trashMetas.map(({ id, title, folderId, version, contentHash, trashedAt }) => ({ id, title, folderId, version, contentHash, trashedAt })),
    folders: folderMetas.map(({ id, name, parentId, relativePath: filePath }) => ({ id, name, parentId, filePath })),
  };
  writeNewDurable(resolvedManifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  manifestCreated = true;
  if (existsSync(destination)) throw new VaultStorageError("Migration target appeared before cutover; no existing directory was changed.", "vault_destination_exists", 409);
  renameSync(staging, destination);
  fsyncDirectory(parent);
  return { vaultId, documentCount: documentMetas.length, folderCount: folderMetas.length, sequence };
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    if (manifestCreated && existsSync(resolvedManifest)) unlinkSync(resolvedManifest);
    throw error;
  }
}
