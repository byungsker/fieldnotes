import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { excerptFromMarkdown } from "./markdown.js";
import type { ChangeRecord, DocumentRecord, FolderRecord } from "./types.js";
import type { VisualizationTrashNote } from "../../shared/visualization.js";
import { ViewQueryLimitError } from "../view-query-limits.js";
import {
  STATE_FILE,
  STATE_FORMAT,
  STATE_VERSION,
  TEMP_PREFIX,
  MAX_VAULT_FILE_BYTES,
  MAX_VAULT_ASSET_BYTES,
  LOCAL_RASTER_EXTENSIONS,
  UUID_PATTERN,
} from "./vault/constants.js";
import { VaultStorageError, VaultVersionConflictError } from "./vault/errors.js";
import {
  normalizedNameKey,
  normalizedRelativeKey,
  relativePath,
  parentPath,
  basename,
  titleFromFileName,
  safeNoteFileName,
} from "./vault/paths.js";
import {
  hashBytes,
  fileKey,
  statKind,
  fsyncDirectory,
  writeAtomic,
  readRegularFileNoFollow,
  exactEntryExists,
} from "./vault/files.js";
import { isRecord, shallowState } from "./vault/manifest.js";
import type {
  FileKey,
  VaultDocumentMeta,
  VaultTrashMeta,
  VaultFolderMeta,
  PendingOperation,
  VaultState,
  VaultSnapshot,
  VaultDocumentReadResult,
  ScannedFolder,
  ScannedDocument,
} from "./vault/types.js";

export { MAX_VAULT_ASSET_BYTES } from "./vault/constants.js";
export { VaultStorageError, VaultVersionConflictError } from "./vault/errors.js";
export { readDescriptorBounded } from "./vault/files.js";
export { createVaultFromLegacy } from "./vault/migration.js";
export type { VaultDocumentMeta, VaultTrashMeta, VaultFolderMeta, VaultState, VaultSnapshot, LegacyDocument, LegacyTrashedDocument, LegacyFolder } from "./vault/types.js";

function eventFor(
  state: VaultState,
  entityType: ChangeRecord["entityType"],
  id: string,
  title: string,
  operation: ChangeRecord["operation"],
  version: number,
  createdAt = new Date().toISOString(),
): ChangeRecord {
  const common = { seq: state.sequence + 1, entityType, title, operation, version, createdAt };
  return entityType === "folder"
    ? { ...common, entityType, folderId: id }
    : { ...common, entityType, documentId: id };
}

export class FileVault {
  readonly rootDir: string;
  readonly metadataDir: string;
  readonly statePath: string;
  private state: VaultState;

  static inspectTarget(root: string): "empty" | "managed" {
    const absolute = path.resolve(root);
    if (!existsSync(absolute)) throw new VaultStorageError("The selected folder no longer exists.", "vault_target_missing", 400);
    if (statKind(absolute) === "symlink") throw new VaultStorageError("The selected vault folder cannot be a symbolic link.", "vault_symlink", 400);
    if (statKind(absolute) !== "directory") throw new VaultStorageError("The selected vault path is not a directory.", "vault_target_invalid", 400);
    try {
      accessSync(absolute, constants.R_OK | constants.W_OK);
    } catch {
      throw new VaultStorageError("The selected vault folder must be readable and writable by the Fieldnotes server.", "vault_target_permissions", 400);
    }
    if ((lstatSync(absolute).mode & 0o077) !== 0) {
      throw new VaultStorageError("The selected vault folder must be private (permissions 700).", "vault_permissions", 400);
    }
    const entries = readdirSync(absolute);
    if (entries.length === 0) return "empty";
    const metadataEntry = entries.find((entry) => normalizedNameKey(entry) === ".fieldnotes");
    if (!metadataEntry) throw new VaultStorageError("Choose an empty private folder or an existing Fieldnotes vault. Other files will not be imported.", "vault_target_unmanaged", 400);
    if (metadataEntry !== ".fieldnotes") throw new VaultStorageError("The selected folder contains a case- or Unicode-equivalent reserved .fieldnotes name.", "vault_reserved_name", 400);
    const metadataPath = path.join(absolute, metadataEntry);
    if (statKind(metadataPath) === "symlink") throw new VaultStorageError("The .fieldnotes metadata directory cannot be a symbolic link.", "vault_symlink", 400);
    if (statKind(metadataPath) !== "directory") throw new VaultStorageError("The selected folder has invalid Fieldnotes metadata.", "vault_state_invalid", 400);
    if ((lstatSync(metadataPath).mode & 0o077) !== 0) throw new VaultStorageError("Fieldnotes metadata must be private (permissions 700).", "vault_permissions", 400);
    const stateEntry = readdirSync(metadataPath).find((entry) => normalizedNameKey(entry) === normalizedNameKey(STATE_FILE));
    if (stateEntry !== STATE_FILE) throw new VaultStorageError("The selected folder does not contain a valid Fieldnotes manifest.", "vault_state_invalid", 400);
    const statePath = path.join(metadataPath, STATE_FILE);
    if (statKind(statePath) !== "file") throw new VaultStorageError("Fieldnotes state must be a regular file.", "vault_state_invalid", 400);
    if ((lstatSync(statePath).mode & 0o077) !== 0) throw new VaultStorageError("Fieldnotes state must be private (permissions 600).", "vault_permissions", 400);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      throw new VaultStorageError("The Fieldnotes manifest is unreadable.", "vault_state_invalid", 400);
    }
    const migrated = isRecord(parsed) && parsed.schemaVersion === 1
      ? { ...parsed, schemaVersion: STATE_VERSION, trashedDocuments: [] }
      : parsed;
    if (!shallowState(migrated)) throw new VaultStorageError("The Fieldnotes manifest has an unsupported format.", "vault_state_invalid", 400);
    return "managed";
  }

  static hasState(root: string): boolean {
    const absolute = path.resolve(root);
    if (!existsSync(absolute) || statKind(absolute) !== "directory") return false;
    const reserved = readdirSync(absolute).find((entry) => normalizedNameKey(entry) === ".fieldnotes");
    if (!reserved) return false;
    if (reserved !== ".fieldnotes") throw new VaultStorageError("The vault root contains a case- or Unicode-equivalent reserved .fieldnotes name.", "vault_reserved_name", 409);
    const metadataPath = path.join(absolute, reserved);
    if (statKind(metadataPath) === "symlink") throw new VaultStorageError("The .fieldnotes metadata directory cannot be a symbolic link.", "vault_symlink", 409);
    if (statKind(metadataPath) !== "directory") throw new VaultStorageError("The reserved .fieldnotes entry is not a directory.", "vault_state_invalid", 409);
    const stateEntry = readdirSync(metadataPath).find((entry) => normalizedNameKey(entry) === normalizedNameKey(STATE_FILE));
    if (stateEntry && stateEntry !== STATE_FILE) throw new VaultStorageError("The vault metadata contains a case-variant state filename.", "vault_state_invalid", 409);
    return stateEntry === STATE_FILE;
  }

  constructor(root: string) {
    const requestedRoot = path.resolve(root);
    if (existsSync(requestedRoot) && statKind(requestedRoot) === "symlink") {
      throw new VaultStorageError("The configured vault root cannot be a symbolic link.", "vault_symlink", 409);
    }
    const rootExisted = existsSync(requestedRoot);
    mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    if (statKind(requestedRoot) !== "directory") throw new VaultStorageError("The configured vault root is not a directory.");
    this.rootDir = path.resolve(requestedRoot);
    if (Buffer.byteLength(this.rootDir, "utf8") > 900) throw new VaultStorageError("The configured vault root exceeds the portable 900-byte path limit.", "vault_path_too_long", 409);
    if (rootExisted && (lstatSync(this.rootDir).mode & 0o077) !== 0) {
      throw new VaultStorageError("The Fieldnotes vault root must be private (mode 700).", "vault_permissions", 409);
    }
    if (!rootExisted) chmodSync(this.rootDir, 0o700);
    const reservedEntry = readdirSync(this.rootDir).find((entry) => normalizedNameKey(entry) === ".fieldnotes");
    if (reservedEntry && reservedEntry !== ".fieldnotes") {
      throw new VaultStorageError("The vault root contains a case- or Unicode-equivalent reserved .fieldnotes name.", "vault_reserved_name", 409);
    }
    this.metadataDir = path.join(this.rootDir, ".fieldnotes");
    if (existsSync(this.metadataDir) && statKind(this.metadataDir) === "symlink") {
      throw new VaultStorageError("The .fieldnotes metadata directory cannot be a symbolic link.", "vault_symlink", 409);
    }
    mkdirSync(this.metadataDir, { recursive: true, mode: 0o700 });
    chmodSync(this.metadataDir, 0o700);
    this.statePath = path.join(this.metadataDir, STATE_FILE);
    if (existsSync(this.statePath)) {
      if (statKind(this.statePath) !== "file") throw new VaultStorageError("Vault state must be a regular file.", "vault_state_invalid", 409);
      chmodSync(this.statePath, 0o600);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
      } catch {
        throw new VaultStorageError("Vault metadata is unreadable; original Markdown files were left untouched.", "vault_state_invalid", 409);
      }
      const migrated = isRecord(parsed) && parsed.schemaVersion === 1
        ? { ...parsed, schemaVersion: STATE_VERSION, trashedDocuments: [] }
        : parsed;
      if (!shallowState(migrated)) throw new VaultStorageError("Vault metadata has an unsupported format; original Markdown files were left untouched.", "vault_state_invalid", 409);
      this.state = migrated;
      if (migrated !== parsed) writeAtomic(this.statePath, Buffer.from(`${JSON.stringify(this.state, null, 2)}\n`, "utf8"));
    } else {
      this.state = {
        format: STATE_FORMAT,
        schemaVersion: STATE_VERSION,
        vaultId: randomUUID(),
        sequence: 0,
        documents: [],
        trashedDocuments: [],
        folders: [],
        changes: [],
      };
      writeAtomic(this.statePath, Buffer.from(`${JSON.stringify(this.state, null, 2)}\n`, "utf8"));
    }
  }

  get sequence(): number {
    return this.state.sequence;
  }

  get vaultId(): string {
    return this.state.vaultId;
  }

  get hasPendingOperation(): boolean {
    return Boolean(this.state.pending);
  }

  getDocumentMeta(id: string): VaultDocumentMeta | undefined {
    return this.state.documents.find((document) => document.id === id);
  }

  listTrashedDocuments(limit = 500, maxBytes = Number.MAX_SAFE_INTEGER): VisualizationTrashNote[] {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 500) throw new RangeError("Trash query limit must be between 0 and 500.");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Trash query byte limit is invalid.");
    const candidates = [...this.state.trashedDocuments]
      .sort((left, right) => right.trashedAt.localeCompare(left.trashedAt) || right.id.localeCompare(left.id))
      .slice(0, limit);
    let scannedBytes = 0;
    return candidates.map((meta) => {
      const remainingBytes = maxBytes - scannedBytes;
      const info = this.trashFileInfo(meta.id, false, remainingBytes);
      if (!info || info.contentHash !== meta.contentHash) {
        throw new VaultVersionConflictError(meta.version, info?.contentHash ?? "0".repeat(64));
      }
      scannedBytes += info.byteLength;
      return {
        id: meta.id,
        title: meta.title,
        folderId: meta.folderId,
        trashedAt: meta.trashedAt,
        version: meta.version,
        excerpt: excerptFromMarkdown(info.body, 150),
      };
    });
  }

  getFolderMeta(id: string): VaultFolderMeta | undefined {
    return this.state.folders.find((folder) => folder.id === id);
  }

  getDocumentPath(id: string): string | undefined {
    return this.getDocumentMeta(id)?.relativePath;
  }

  readDocument(id: string): VaultDocumentReadResult {
    let meta = this.getDocumentMeta(id);
    if (!meta) return { changes: [], fullReconcile: false };

    let info: ReturnType<FileVault["fileInfo"]>;
    try {
      info = this.fileInfo(meta.relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const result = this.reconcile();
      meta = this.getDocumentMeta(id);
      if (!meta) return { changes: result.changes, fullReconcile: true };
      info = this.fileInfo(meta.relativePath);
      return {
        document: this.documentRecord(meta, info.body),
        changes: result.changes,
        fullReconcile: true,
      };
    }

    const changedContent = info.contentHash !== meta.contentHash;
    const changedFileKey = info.key.device !== meta.device || info.key.inode !== meta.inode;
    if (changedContent || changedFileKey) {
      let updatedMeta = { ...meta, device: info.key.device, inode: info.key.inode };
      const changes = changedContent ? [eventFor(
        this.state,
        "document",
        id,
        meta.title,
        "updated",
        meta.version + 1,
      )] : [];
      if (changedContent) {
        updatedMeta = {
          ...updatedMeta,
          contentHash: info.contentHash,
          updatedAt: changes[0]!.createdAt,
          version: meta.version + 1,
        };
      }
      const sequencedChanges = changes.map((change) => ({ ...change, seq: this.state.sequence + 1 }));
      this.persist({
        ...this.state,
        sequence: sequencedChanges.at(-1)?.seq ?? this.state.sequence,
        documents: this.state.documents.map((document) => document.id === id ? updatedMeta : document),
        changes: [...this.state.changes, ...sequencedChanges],
      });
      meta = updatedMeta;
      return { document: this.documentRecord(meta, info.body), changes: sequencedChanges, fullReconcile: false };
    }
    return { document: this.documentRecord(meta, info.body), changes: [], fullReconcile: false };
  }

  readAsset(relativePath: string, maxBytes: number): Buffer {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_VAULT_ASSET_BYTES) {
      throw new RangeError("The vault image size limit is invalid.");
    }
    const absolute = this.safeAbsolute(relativePath);
    if (statKind(absolute) !== "file") throw new VaultStorageError("The referenced vault asset is not a regular file.", "vault_entry_invalid", 404);
    try {
      return readRegularFileNoFollow(absolute, maxBytes, this.rootDir, MAX_VAULT_ASSET_BYTES);
    } catch (error) {
      if (error instanceof ViewQueryLimitError) {
        throw new VaultStorageError("The referenced vault image exceeds the view asset size limit.", "vault_asset_too_large", 413);
      }
      throw error;
    }
  }

  resolveAssetPath(relativePath: string, resolveUniqueBasename = false): string | undefined {
    const absolute = this.safeAbsolute(relativePath);
    try {
      if (statKind(absolute) === "file") return relativePath;
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!resolveUniqueBasename) return undefined;

    const fileName = path.posix.basename(relativePath);
    if (!fileName || !LOCAL_RASTER_EXTENSIONS.has(path.posix.extname(fileName).toLowerCase())) return undefined;
    const nameKey = normalizedNameKey(fileName);
    const matches: string[] = [];
    const walk = (directory: string, parent: string): void => {
      const entries = readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!parent && entry.name === ".fieldnotes") continue;
        const entryKey = normalizedNameKey(entry.name);
        if (entryKey === ".fieldnotes" || entryKey.startsWith(normalizedNameKey(TEMP_PREFIX))) continue;
        const childRelative = path.posix.join(parent, entry.name);
        const absoluteChild = path.join(directory, entry.name);
        let kind: ReturnType<typeof statKind>;
        try {
          kind = statKind(absoluteChild);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (kind === "directory") {
          walk(absoluteChild, childRelative);
        } else if (kind === "file" && entryKey === nameKey) {
          matches.push(childRelative);
          if (matches.length > 1) return;
        }
      }
    };
    walk(this.rootDir, "");
    return matches.length === 1 ? matches[0] : undefined;
  }

  getFolderPath(id: string): string | undefined {
    return this.getFolderMeta(id)?.relativePath;
  }

  private persist(next: VaultState): void {
    writeAtomic(this.statePath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"));
    this.state = next;
  }

  private safeAbsolute(relative: string, allowMissing = false): string {
    if (!relative) return this.rootDir;
    if (relative.startsWith("/") || relative.includes("\\") || relative.includes("\u0000") || /^[A-Za-z]:/.test(relative)) {
      throw new VaultStorageError("Vault paths must be relative POSIX paths.", "vault_path_invalid", 409);
    }
    const segments = relative.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".fieldnotes")) {
      throw new VaultStorageError("Vault path contains a reserved or unsafe component.", "vault_path_invalid", 409);
    }
    let current = this.rootDir;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        if (statKind(current) === "symlink") throw new VaultStorageError("Symbolic links are not allowed inside a Fieldnotes vault.", "vault_symlink", 409);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) break;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return current;
        throw error;
      }
    }
    const resolved = path.resolve(current);
    if (resolved !== this.rootDir && !resolved.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new VaultStorageError("Vault path escaped the configured root.", "vault_path_invalid", 409);
    }
    if (Buffer.byteLength(resolved, "utf8") > 900) {
      throw new VaultStorageError("The absolute vault path exceeds the portable 900-byte limit.", "vault_path_too_long", 409);
    }
    return resolved;
  }

  private safeTrashAbsolute(id: string, allowMissing = false): string {
    if (!UUID_PATTERN.test(id)) throw new VaultStorageError("Trash entries require a valid note id.", "vault_path_invalid", 400);
    const trashDirectory = path.join(this.metadataDir, "trash");
    if (existsSync(trashDirectory) && statKind(trashDirectory) === "symlink") {
      throw new VaultStorageError("The private trash directory cannot be a symbolic link.", "vault_symlink", 409);
    }
    if (!existsSync(trashDirectory) && !allowMissing) {
      throw new VaultStorageError("The private trash entry is missing.", "vault_entry_invalid", 409);
    }
    if (!existsSync(trashDirectory) && allowMissing) mkdirSync(trashDirectory, { recursive: false, mode: 0o700 });
    if (existsSync(trashDirectory) && statKind(trashDirectory) !== "directory") {
      throw new VaultStorageError("The private trash path is not a directory.", "vault_entry_invalid", 409);
    }
    if (existsSync(trashDirectory)) chmodSync(trashDirectory, 0o700);
    return path.join(trashDirectory, `${id}.md`);
  }

  private trashFileInfo(id: string, allowMissing = false, maxBytes = MAX_VAULT_FILE_BYTES): { body: string; contentHash: string; byteLength: number } | undefined {
    const absolute = this.safeTrashAbsolute(id, allowMissing);
    if (!existsSync(absolute)) return undefined;
    if (statKind(absolute) !== "file") throw new VaultStorageError("A trash entry must be a regular file.", "vault_entry_invalid", 409);
    const bytes = readRegularFileNoFollow(absolute, maxBytes);
    if (bytes.byteLength > MAX_VAULT_FILE_BYTES) throw new VaultStorageError("A trashed note exceeds the vault file limit.", "vault_file_too_large", 409);
    let body: string;
    try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new VaultStorageError("A trashed note is not valid UTF-8.", "vault_invalid_encoding", 409); }
    if (body.length > 250_000) throw new VaultStorageError("A trashed note exceeds the index limit.", "vault_file_too_large", 409);
    return { body, contentHash: hashBytes(bytes), byteLength: bytes.byteLength };
  }

  private fileInfo(relative: string): { body: string; contentHash: string; key: FileKey; byteLength: number } {
    const absolute = this.safeAbsolute(relative);
    if (statKind(absolute) !== "file") throw new VaultStorageError("Expected a regular Markdown file.", "vault_entry_invalid", 409);
    const bytes = readRegularFileNoFollow(absolute, MAX_VAULT_FILE_BYTES, this.rootDir, MAX_VAULT_FILE_BYTES, "vault");
    if (bytes.byteLength > MAX_VAULT_FILE_BYTES) {
      throw new VaultStorageError(`Markdown file exceeds the ${MAX_VAULT_FILE_BYTES} byte vault limit.`, "vault_file_too_large", 409);
    }
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new VaultStorageError("Markdown file is not valid UTF-8.", "vault_invalid_encoding", 409);
    }
    if (body.length > 250_000) throw new VaultStorageError("Markdown file exceeds the 250,000 character index limit.", "vault_file_too_large", 409);
    return { body, contentHash: hashBytes(bytes), key: fileKey(absolute), byteLength: bytes.byteLength };
  }

  private scanDisk(): { folders: ScannedFolder[]; documents: ScannedDocument[] } {
    const folders: ScannedFolder[] = [];
    const documents: ScannedDocument[] = [];
    const collisionNames = new Map<string, string>();
    const walk = (directory: string, parent: string): void => {
      const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (!parent && entry.name === ".fieldnotes") continue;
        if (normalizedNameKey(entry.name) === ".fieldnotes") {
          throw new VaultStorageError("The .fieldnotes directory name is reserved for vault metadata.", "vault_reserved_name", 409);
        }
        if (normalizedNameKey(entry.name).startsWith(normalizedNameKey(TEMP_PREFIX))) {
          throw new VaultStorageError("A reserved in-progress filename was found. Inspect it before reconciling the vault.", "vault_pending_file", 409);
        }
        const absolute = path.join(directory, entry.name);
        if (Buffer.byteLength(absolute, "utf8") > 900) {
          throw new VaultStorageError("A vault entry exceeds the portable 900-byte path limit.", "vault_path_too_long", 409);
        }
        const kind = statKind(absolute);
        if (kind === "symlink") {
          throw new VaultStorageError(`Symbolic link found in vault at ${relativePath(parent, entry.name)}; reconciliation stopped without indexing it.`, "vault_symlink", 409);
        }
        if (kind === "other") continue;
        const key = `${normalizedRelativeKey(parent)}\u0000${normalizedNameKey(entry.name)}`;
        const seen = collisionNames.get(key);
        if (seen && seen !== entry.name) {
          throw new VaultStorageError(`Filesystem name collision in the vault near ${relativePath(parent, entry.name)}. Resolve case or Unicode-equivalent names before continuing.`, "vault_name_collision", 409);
        }
        collisionNames.set(key, entry.name);
        if (kind === "directory") {
          if ([...entry.name].length > 120) {
            throw new VaultStorageError(`Folder name exceeds the 120-character limit: ${relativePath(parent, entry.name)}`, "vault_name_too_long", 409);
          }
          const rel = relativePath(parent, entry.name);
          folders.push({ ...fileKey(absolute), name: entry.name, relativePath: rel, parentPath: parent });
          walk(absolute, rel);
          continue;
        }
        if (!/\.(?:md|markdown)$/i.test(entry.name)) continue;
        const title = titleFromFileName(entry.name);
        if ([...title].length > 160) {
          throw new VaultStorageError(`Markdown filename exceeds the 160-character title limit: ${relativePath(parent, entry.name)}`, "vault_name_too_long", 409);
        }
        const bytes = readRegularFileNoFollow(absolute);
        if (bytes.byteLength > MAX_VAULT_FILE_BYTES) {
          throw new VaultStorageError(`Markdown file exceeds the ${MAX_VAULT_FILE_BYTES} byte vault limit: ${relativePath(parent, entry.name)}`, "vault_file_too_large", 409);
        }
        let body: string;
        try {
          body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new VaultStorageError(`Markdown file is not valid UTF-8: ${relativePath(parent, entry.name)}`, "vault_invalid_encoding", 409);
        }
        if (body.length > 250_000) throw new VaultStorageError(`Markdown file exceeds the 250,000 character index limit: ${relativePath(parent, entry.name)}`, "vault_file_too_large", 409);
        documents.push({
          ...fileKey(absolute),
          name: entry.name,
          relativePath: relativePath(parent, entry.name),
          parentPath: parent,
          body,
          contentHash: hashBytes(bytes),
          byteLength: bytes.byteLength,
        });
      }
    };
    walk(this.rootDir, "");
    folders.sort((left, right) => left.relativePath.split("/").length - right.relativePath.split("/").length || left.relativePath.localeCompare(right.relativePath));
    documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return { folders, documents };
  }

  private relativeForFolderId(id: string | null): string {
    if (id === null) return "";
    const folder = this.getFolderMeta(id);
    if (!folder) throw new VaultStorageError("Folder not found in the configured vault.", "not_found", 404);
    return folder.relativePath;
  }

  private assertSiblingAvailable(parent: string, name: string, exceptRelativePath?: string): void {
    const key = normalizedNameKey(name);
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || [...name].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    }) || name.endsWith(".") || name.endsWith(" ") || key === ".fieldnotes" || key.startsWith(normalizedNameKey(TEMP_PREFIX))) {
      throw new VaultStorageError("The filesystem name is reserved or unsafe.", "vault_name_invalid", 400);
    }
    const parentAbsolute = this.safeAbsolute(parent);
    const actual = readdirSync(parentAbsolute);
    const exceptName = exceptRelativePath && parentPath(exceptRelativePath) === parent ? basename(exceptRelativePath) : undefined;
    for (const existing of actual) {
      if (existing === exceptName) continue;
      if (existing.startsWith(TEMP_PREFIX)) continue;
      if (normalizedNameKey(existing) === key) {
        throw new VaultStorageError("A filesystem entry with a case- or Unicode-equivalent name already exists in this folder.", "vault_name_collision", 409);
      }
    }
  }

  private notePath(title: string, id: string, folderId: string | null, except?: string): string {
    const parent = this.relativeForFolderId(folderId);
    let fileName = safeNoteFileName(title, id);
    try {
      this.assertSiblingAvailable(parent, fileName, except);
    } catch (error) {
      if (!(error instanceof VaultStorageError) || error.code !== "vault_name_collision") throw error;
      fileName = safeNoteFileName(title, id, true);
      this.assertSiblingAvailable(parent, fileName, except);
    }
    return relativePath(parent, fileName);
  }

  private tempRelative(target: string): string {
    return relativePath(parentPath(target), `${TEMP_PREFIX}${randomUUID()}`);
  }

  private writeNew(relative: string, temporary: string, body: string): void {
    const target = this.safeAbsolute(relative, true);
    const temp = this.safeAbsolute(temporary, true);
    const parent = path.dirname(target);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    this.assertSiblingAvailable(parentPath(relative), basename(relative));
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temp, "wx", 0o600);
      writeFileSync(descriptor, Buffer.from(body, "utf8"));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      linkSync(temp, target);
      unlinkSync(temp);
      fsyncDirectory(parent);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error;
    }
  }

  private writeReplace(relative: string, temporary: string, body: string, expectedHash: string): void {
    const target = this.safeAbsolute(relative);
    const temp = this.safeAbsolute(temporary, true);
    const parent = path.dirname(target);
    if (statKind(target) !== "file") throw new VaultStorageError("Refusing to replace a non-regular Markdown file.", "vault_entry_invalid", 409);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temp, "wx", 0o600);
      writeFileSync(descriptor, Buffer.from(body, "utf8"));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      const current = this.fileInfo(relative);
      if (current.contentHash !== expectedHash) {
        throw new VaultVersionConflictError(this.getDocumentMetaByPath(relative)?.version ?? 1, current.contentHash);
      }
      renameSync(temp, target);
      fsyncDirectory(parent);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error;
    }
  }

  private getDocumentMetaByPath(relative: string): VaultDocumentMeta | undefined {
    return this.state.documents.find((document) => document.relativePath === relative);
  }

  private pathExists(relative: string): boolean {
    if (!relative) return false;
    const parent = this.safeAbsolute(parentPath(relative), true);
    return exactEntryExists(parent, basename(relative));
  }

  private statFileKey(relative: string): FileKey {
    return fileKey(this.safeAbsolute(relative));
  }

  private persistPending(pending: PendingOperation): void {
    this.persist({ ...this.state, pending });
  }

  private clearPending(): void {
    const next = { ...this.state, pending: undefined };
    this.persist(next);
  }

  private appendChange(nextState: VaultState, change: ChangeRecord): VaultState {
    return {
      ...nextState,
      sequence: change.seq,
      changes: [...nextState.changes, change],
      pending: undefined,
    };
  }

  private completePending(pending: PendingOperation): void {
    const state = this.state;
    if (state.pending?.change.seq !== pending.change.seq) {
      throw new VaultStorageError("Vault operation journal changed unexpectedly.", "vault_state_conflict", 409);
    }
    if (pending.kind === "document-create" || pending.kind === "document-update") {
      const info = this.fileInfo(pending.next.relativePath);
      const next: VaultDocumentMeta = { ...pending.next, ...info.key };
      const documents = state.documents.filter((document) => document.id !== next.id);
      documents.push(next);
      if (pending.kind === "document-update" && pending.oldPath !== next.relativePath && this.pathExists(pending.oldPath)) {
        const old = this.fileInfo(pending.oldPath);
        if (old.contentHash !== pending.oldHash) {
          throw new VaultStorageError("The old file changed during a rename; both files were preserved for conflict resolution.", "vault_external_conflict", 409);
        }
        unlinkSync(this.safeAbsolute(pending.oldPath));
        fsyncDirectory(path.dirname(this.safeAbsolute(pending.oldPath)));
      }
      const nextState = { ...state, documents };
      this.persist(this.appendChange(nextState, pending.change));
      const tempPath = pending.tempPath;
      if (this.pathExists(tempPath)) unlinkSync(this.safeAbsolute(tempPath));
      return;
    }
    if (pending.kind === "document-delete") {
      const documents = state.documents.filter((document) => document.id !== pending.id);
      this.persist(this.appendChange({ ...state, documents }, pending.change));
      return;
    }
    if (pending.kind === "document-trash") {
      const current = state.documents.find((document) => document.id === pending.id);
      const info = this.trashFileInfo(pending.id);
      if (!current || !info || info.contentHash !== pending.oldHash || current.contentHash !== pending.oldHash) {
        throw new VaultStorageError("The trash operation could not verify the original Markdown; the note was preserved.", "vault_external_conflict", 409);
      }
      const absolute = this.safeTrashAbsolute(pending.id);
      const nextTrash: VaultTrashMeta = {
        ...current,
        ...fileKey(absolute),
        trashPath: pending.trashPath,
        trashedAt: pending.trashedAt,
      };
      const nextState = {
        ...state,
        documents: state.documents.filter((document) => document.id !== pending.id),
        trashedDocuments: [...state.trashedDocuments.filter((document) => document.id !== pending.id), nextTrash],
      };
      this.persist(this.appendChange(nextState, pending.change));
      return;
    }
    if (pending.kind === "document-restore") {
      const info = this.fileInfo(pending.next.relativePath);
      if (info.contentHash !== pending.next.contentHash) throw new VaultStorageError("The restored Markdown changed before it could be indexed.", "vault_external_conflict", 409);
      const restored: VaultDocumentMeta = { ...pending.next, ...info.key };
      const nextState = {
        ...state,
        documents: [...state.documents.filter((document) => document.id !== pending.id), restored],
        trashedDocuments: state.trashedDocuments.filter((document) => document.id !== pending.id),
      };
      this.persist(this.appendChange(nextState, pending.change));
      return;
    }
    if (pending.kind === "folder-create") {
      const key = this.statFileKey(pending.next.relativePath);
      const folders = [...state.folders.filter((folder) => folder.id !== pending.next.id), { ...pending.next, ...key }];
      this.persist(this.appendChange({ ...state, folders }, pending.change));
      return;
    }
    if (pending.kind === "folder-update") {
      const key = this.statFileKey(pending.next.relativePath);
      const oldPrefix = `${pending.oldPath}/`;
      const newPrefix = `${pending.next.relativePath}/`;
      const folders = state.folders.map((folder) => {
        if (folder.id === pending.next.id) return { ...pending.next, ...key };
        if (folder.relativePath.startsWith(oldPrefix)) {
          return { ...folder, relativePath: `${newPrefix}${folder.relativePath.slice(oldPrefix.length)}` };
        }
        return folder;
      });
      const documents = state.documents.map((document) => document.relativePath.startsWith(oldPrefix)
        ? { ...document, relativePath: `${newPrefix}${document.relativePath.slice(oldPrefix.length)}` }
        : document);
      this.persist(this.appendChange({ ...state, folders, documents }, pending.change));
      return;
    }
    if (pending.kind === "folder-delete") {
      const folders = state.folders.filter((folder) => folder.id !== pending.id);
      this.persist(this.appendChange({ ...state, folders }, pending.change));
    }
  }

  private recoverPending(): ChangeRecord[] {
    const pending = this.state.pending;
    if (!pending) return [];
    const oldSequence = this.state.sequence;
    const hashAt = (relative: string): string | undefined => {
      if (!this.pathExists(relative)) return undefined;
      const absolute = this.safeAbsolute(relative);
      if (statKind(absolute) !== "file") return undefined;
      return hashBytes(readRegularFileNoFollow(absolute));
    };
    if (pending.kind === "document-create") {
      const current = hashAt(pending.next.relativePath);
      if (current === pending.next.contentHash) this.completePending(pending);
      else if (current === undefined) {
        if (this.pathExists(pending.tempPath)) unlinkSync(this.safeAbsolute(pending.tempPath));
        this.clearPending();
      } else throw new VaultStorageError("A pending note creation conflicts with a different file; nothing was overwritten.", "vault_external_conflict", 409);
    } else if (pending.kind === "document-update") {
      const nextHash = hashAt(pending.next.relativePath);
      if (pending.oldPath === pending.next.relativePath) {
        if (nextHash === pending.next.contentHash) this.completePending(pending);
        else if (nextHash === pending.oldHash) {
          if (this.pathExists(pending.tempPath)) unlinkSync(this.safeAbsolute(pending.tempPath));
          this.clearPending();
        } else throw new VaultStorageError("A pending note save conflicts with a file changed by another process.", "vault_external_conflict", 409);
      } else if (nextHash === pending.next.contentHash) {
        const oldHash = hashAt(pending.oldPath);
        if (oldHash !== undefined && oldHash !== pending.oldHash) {
          throw new VaultStorageError("A pending note rename conflicts with an external edit; both files were preserved.", "vault_external_conflict", 409);
        }
        this.completePending(pending);
      } else {
        const oldHash = hashAt(pending.oldPath);
        if (oldHash === pending.oldHash && nextHash === undefined) {
          if (this.pathExists(pending.tempPath)) unlinkSync(this.safeAbsolute(pending.tempPath));
          this.clearPending();
        } else throw new VaultStorageError("A pending note rename could not be reconciled safely.", "vault_external_conflict", 409);
      }
    } else if (pending.kind === "document-delete") {
      const current = hashAt(pending.oldPath);
      if (current === undefined) this.completePending(pending);
      else if (current === pending.oldHash) this.clearPending();
      else throw new VaultStorageError("A pending delete conflicts with a file changed by another process.", "vault_external_conflict", 409);
    } else if (pending.kind === "document-trash") {
      const original = hashAt(pending.oldPath);
      const trashed = this.trashFileInfo(pending.id, true)?.contentHash;
      if (original === pending.oldHash && trashed === undefined) this.clearPending();
      else if (original === undefined && trashed === pending.oldHash) this.completePending(pending);
      else throw new VaultStorageError("A pending trash operation conflicts with a changed Markdown file; both copies were preserved.", "vault_external_conflict", 409);
    } else if (pending.kind === "document-restore") {
      const trashed = this.trashFileInfo(pending.id, true)?.contentHash;
      const restored = hashAt(pending.next.relativePath);
      if (trashed === undefined && restored === pending.next.contentHash) this.completePending(pending);
      else if (trashed === pending.next.contentHash && restored === undefined) this.clearPending();
      else throw new VaultStorageError("A pending restore conflicts with a changed Markdown file; both copies were preserved.", "vault_external_conflict", 409);
    } else if (pending.kind === "folder-create") {
      if (this.pathExists(pending.next.relativePath)) {
        if (statKind(this.safeAbsolute(pending.next.relativePath)) !== "directory") throw new VaultStorageError("A pending folder creation conflicts with a non-folder entry.", "vault_external_conflict", 409);
        this.completePending(pending);
      } else this.clearPending();
    } else if (pending.kind === "folder-update") {
      if (pending.tempPath && this.pathExists(pending.tempPath)) {
        if (this.pathExists(pending.next.relativePath)) throw new VaultStorageError("A pending folder rename has both temporary and destination paths; resolve it before continuing.", "vault_external_conflict", 409);
        renameSync(this.safeAbsolute(pending.tempPath), this.safeAbsolute(pending.next.relativePath, true));
        fsyncDirectory(path.dirname(this.safeAbsolute(pending.next.relativePath)));
      }
      const sourceExists = this.pathExists(pending.oldPath);
      const targetExists = this.pathExists(pending.next.relativePath);
      if (targetExists && !sourceExists) this.completePending(pending);
      else if (sourceExists && !targetExists) this.clearPending();
      else throw new VaultStorageError("A pending folder move could not be reconciled safely.", "vault_external_conflict", 409);
    } else if (pending.kind === "folder-delete") {
      if (!this.pathExists(pending.oldPath)) this.completePending(pending);
      else if (statKind(this.safeAbsolute(pending.oldPath)) === "directory" && readdirSync(this.safeAbsolute(pending.oldPath)).length === 0) this.clearPending();
      else throw new VaultStorageError("A pending folder delete conflicts with a non-empty or changed directory.", "vault_external_conflict", 409);
    }
    return this.state.sequence > oldSequence ? this.state.changes.filter((change) => change.seq > oldSequence) : [];
  }

  private scanAndReconcile(): { changed: boolean; changes: ChangeRecord[] } {
    const recovered = this.recoverPending();
    const previous = this.state;
    const disk = this.scanDisk();
    const changes: ChangeRecord[] = [];
    const oldFolders = previous.folders;
    const remainingFolderIds = new Set(oldFolders.map((folder) => folder.id));
    const folderByPath = new Map(oldFolders.map((folder) => [folder.relativePath, folder]));
    const folderByKey = new Map<string, VaultFolderMeta[]>();
    for (const folder of oldFolders) {
      const key = `${folder.device}:${folder.inode}`;
      const candidates = folderByKey.get(key) ?? [];
      candidates.push(folder);
      folderByKey.set(key, candidates);
    }
    const currentFolders: VaultFolderMeta[] = [];
    const currentFolderByPath = new Map<string, VaultFolderMeta>();
    for (const scanned of disk.folders) {
      let old = folderByPath.get(scanned.relativePath);
      if (old && !remainingFolderIds.has(old.id)) old = undefined;
      if (!old) {
        const candidates = (folderByKey.get(`${scanned.device}:${scanned.inode}`) ?? []).filter((folder) => remainingFolderIds.has(folder.id));
        if (candidates.length === 1) old = candidates[0];
      }
      const parentId = scanned.parentPath ? currentFolderByPath.get(scanned.parentPath)?.id ?? null : null;
      const now = new Date().toISOString();
      let next: VaultFolderMeta;
      if (old) {
        remainingFolderIds.delete(old.id);
        const pathNameChanged = basename(old.relativePath).normalize("NFC") !== scanned.name.normalize("NFC");
        const nextName = pathNameChanged ? scanned.name : old.name;
        const semanticChange = pathNameChanged || old.parentId !== parentId;
        const changed = semanticChange ? {
          ...old,
          name: nextName,
          parentId,
          relativePath: scanned.relativePath,
          updatedAt: now,
          version: old.version + 1,
          device: scanned.device,
          inode: scanned.inode,
        } : {
          ...old,
          relativePath: scanned.relativePath,
          device: scanned.device,
          inode: scanned.inode,
        };
        next = changed;
        if (semanticChange) changes.push(eventFor(this.state, "folder", old.id, next.name, "updated", next.version, now));
      } else {
        const id = randomUUID();
        next = {
          id,
          name: scanned.name,
          parentId,
          relativePath: scanned.relativePath,
          createdAt: now,
          updatedAt: now,
          version: 1,
          device: scanned.device,
          inode: scanned.inode,
        };
        changes.push(eventFor(this.state, "folder", id, scanned.name, "created", 1, now));
      }
      currentFolders.push(next);
      currentFolderByPath.set(scanned.relativePath, next);
    }
    for (const old of oldFolders) {
      if (remainingFolderIds.has(old.id)) changes.push(eventFor(this.state, "folder", old.id, old.name, "deleted", old.version + 1));
    }

    const oldDocuments = previous.documents;
    const remainingDocumentIds = new Set(oldDocuments.map((document) => document.id));
    const documentByPath = new Map(oldDocuments.map((document) => [document.relativePath, document]));
    const documentByKey = new Map<string, VaultDocumentMeta[]>();
    for (const document of oldDocuments) {
      const key = `${document.device}:${document.inode}`;
      const candidates = documentByKey.get(key) ?? [];
      candidates.push(document);
      documentByKey.set(key, candidates);
    }
    const currentDocuments: VaultDocumentMeta[] = [];
    for (const scanned of disk.documents) {
      let old = documentByPath.get(scanned.relativePath);
      if (old && !remainingDocumentIds.has(old.id)) old = undefined;
      if (!old) {
        const candidates = (documentByKey.get(`${scanned.device}:${scanned.inode}`) ?? []).filter((document) => remainingDocumentIds.has(document.id));
        if (candidates.length === 1) old = candidates[0];
      }
      const folderId = scanned.parentPath ? currentFolderByPath.get(scanned.parentPath)?.id ?? null : null;
      const now = new Date().toISOString();
      let next: VaultDocumentMeta;
      if (old) {
        remainingDocumentIds.delete(old.id);
        const basenameChanged = basename(old.relativePath).normalize("NFC") !== basename(scanned.relativePath).normalize("NFC");
        const title = basenameChanged ? titleFromFileName(scanned.name, old.id) : old.title;
        const semanticChange = old.contentHash !== scanned.contentHash || old.folderId !== folderId || old.title !== title || basenameChanged;
        next = semanticChange ? {
          ...old,
          title,
          folderId,
          relativePath: scanned.relativePath,
          contentHash: scanned.contentHash,
          updatedAt: now,
          version: old.version + 1,
          device: scanned.device,
          inode: scanned.inode,
        } : {
          ...old,
          relativePath: scanned.relativePath,
          contentHash: scanned.contentHash,
          device: scanned.device,
          inode: scanned.inode,
        };
        if (semanticChange) changes.push(eventFor(this.state, "document", old.id, next.title, "updated", next.version, now));
      } else {
        const id = randomUUID();
        const title = titleFromFileName(scanned.name, id);
        next = {
          id,
          title,
          folderId,
          relativePath: scanned.relativePath,
          createdAt: now,
          updatedAt: now,
          version: 1,
          contentHash: scanned.contentHash,
          device: scanned.device,
          inode: scanned.inode,
        };
        changes.push(eventFor(this.state, "document", id, title, "created", 1, now));
      }
      currentDocuments.push(next);
    }
    for (const old of oldDocuments) {
      if (remainingDocumentIds.has(old.id)) changes.push(eventFor(this.state, "document", old.id, old.title, "deleted", old.version + 1));
    }

    let sequence = previous.sequence;
    const sequencedChanges = changes.map((change) => ({ ...change, seq: ++sequence }));
    const nextState: VaultState = {
      ...previous,
      sequence,
      documents: currentDocuments,
      folders: currentFolders,
      changes: [...previous.changes, ...sequencedChanges],
      pending: undefined,
    };
    const changed = JSON.stringify(nextState) !== JSON.stringify(previous);
    if (changed) this.persist(nextState);
    return { changed, changes: [...recovered, ...sequencedChanges] };
  }

  reconcile(): { changed: boolean; changes: ChangeRecord[] } {
    return this.scanAndReconcile();
  }

  private documentRecord(meta: VaultDocumentMeta, body: string): DocumentRecord {
    return {
      id: meta.id,
      title: meta.title,
      folderId: meta.folderId,
      filePath: meta.relativePath,
      contentHash: meta.contentHash,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      version: meta.version,
      body,
      excerpt: excerptFromMarkdown(body),
    };
  }

  snapshot(): VaultSnapshot {
    const documents: DocumentRecord[] = this.state.documents.map((meta) => {
      const info = this.fileInfo(meta.relativePath);
      if (info.contentHash !== meta.contentHash) {
        throw new VaultStorageError("A Markdown file changed during index refresh; retry after reconciliation.", "vault_external_conflict", 409);
      }
      return {
        id: meta.id,
        title: meta.title,
        folderId: meta.folderId,
        filePath: meta.relativePath,
        contentHash: meta.contentHash,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        version: meta.version,
        body: info.body,
        excerpt: excerptFromMarkdown(info.body),
      };
    });
    const counts = new Map<string, number>();
    for (const document of documents) if (document.folderId) counts.set(document.folderId, (counts.get(document.folderId) ?? 0) + 1);
    const folders: FolderRecord[] = this.state.folders.map((meta) => ({
      id: meta.id,
      name: meta.name,
      parentId: meta.parentId,
      filePath: meta.relativePath,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      version: meta.version,
      documentCount: counts.get(meta.id) ?? 0,
    }));
    return { vaultId: this.state.vaultId, sequence: this.state.sequence, documents, folders, changes: this.state.changes };
  }

  private runPending(pending: PendingOperation, operation: () => void): ChangeRecord {
    this.persistPending(pending);
    try {
      operation();
      this.completePending(pending);
    } catch (error) {
      try { this.recoverPending(); } catch { /* keep the pending record; the next read will fail closed */ }
      throw error;
    }
    return pending.change;
  }

  createDocument(title: string, body: string, folderId: string | null, requestedId?: string): { document: DocumentRecord; change: ChangeRecord } {
    if (body.length > 250_000) throw new VaultStorageError("Markdown body is too large (250 KB maximum).", "vault_file_too_large", 400);
    if (folderId !== null && !this.getFolderMeta(folderId)) throw new VaultStorageError("Folder not found.", "not_found", 404);
    const id = requestedId ?? randomUUID();
    const existingMeta = this.getDocumentMeta(id);
    if (existingMeta) {
      const document = this.snapshot().documents.find((entry) => entry.id === id);
      const change = [...this.state.changes].reverse().find((entry) => entry.documentId === id && entry.operation === "created");
      if (document && change) return { document, change };
    }
    if (requestedId && this.state.changes.some((entry) => entry.documentId === id && entry.operation === "created")) {
      throw new VaultStorageError("This draft id was already used and its note is no longer available.", "idempotency_key_reused", 409);
    }
    const now = new Date().toISOString();
    const relativePath = this.notePath(title, id, folderId);
    const bytes = Buffer.from(body, "utf8");
    const contentHash = hashBytes(bytes);
    const next: Omit<VaultDocumentMeta, keyof FileKey> = {
      id, title, folderId, relativePath, createdAt: now, updatedAt: now, version: 1, contentHash,
    };
    const tempPath = this.tempRelative(relativePath);
    const change = eventFor(this.state, "document", id, title, "created", 1, now);
    const pending: PendingOperation = { kind: "document-create", next, tempPath, change };
    this.runPending(pending, () => this.writeNew(relativePath, tempPath, body));
    const document = this.snapshot().documents.find((entry) => entry.id === id);
    if (!document) throw new VaultStorageError("Created note was not visible after its durable commit.");
    return { document, change };
  }

  updateDocument(
    id: string,
    expectedVersion: number,
    expectedHash: string | undefined,
    title: string,
    body: string,
    folderId: string | null | undefined,
  ): { document: DocumentRecord; change: ChangeRecord } {
    if (body.length > 250_000) throw new VaultStorageError("Markdown body is too large (250 KB maximum).", "vault_file_too_large", 400);
    const current = this.getDocumentMeta(id);
    if (!current) throw new VaultStorageError("Note not found.", "not_found", 404);
    const currentInfo = this.fileInfo(current.relativePath);
    if (current.version !== expectedVersion || currentInfo.contentHash !== current.contentHash || (expectedHash && expectedHash !== current.contentHash)) {
      throw new VaultVersionConflictError(current.version, currentInfo.contentHash);
    }
    const nextFolderId = folderId === undefined ? current.folderId : folderId;
    if (nextFolderId !== null && !this.getFolderMeta(nextFolderId)) throw new VaultStorageError("Folder not found.", "not_found", 404);
    const parent = this.relativeForFolderId(nextFolderId);
    let targetPath = title === current.title
      ? relativePath(parent, basename(current.relativePath))
      : this.notePath(title, id, nextFolderId, current.relativePath);
    // Case-only renames are not portable across case-insensitive APFS volumes.
    // Keep the existing path while still updating the logical title in metadata.
    if (normalizedRelativeKey(targetPath) === normalizedRelativeKey(current.relativePath) && targetPath !== current.relativePath) {
      targetPath = current.relativePath;
    }
    if (title === current.title && targetPath !== current.relativePath) {
      try {
        this.assertSiblingAvailable(parent, basename(targetPath), current.relativePath);
      } catch (error) {
        if (!(error instanceof VaultStorageError) || error.code !== "vault_name_collision") throw error;
        targetPath = relativePath(parent, safeNoteFileName(title, id, true));
        this.assertSiblingAvailable(parent, basename(targetPath), current.relativePath);
      }
    }
    const bytes = Buffer.from(body, "utf8");
    if (bytes.byteLength > MAX_VAULT_FILE_BYTES) throw new VaultStorageError(`Markdown file exceeds the ${MAX_VAULT_FILE_BYTES} byte vault limit.`, "vault_file_too_large", 409);
    const now = new Date().toISOString();
    const next: Omit<VaultDocumentMeta, keyof FileKey> = {
      id,
      title,
      folderId: nextFolderId,
      relativePath: targetPath,
      createdAt: current.createdAt,
      updatedAt: now,
      version: current.version + 1,
      contentHash: hashBytes(bytes),
    };
    const tempPath = this.tempRelative(targetPath);
    const change = eventFor(this.state, "document", id, title, "updated", next.version, now);
    const pending: PendingOperation = { kind: "document-update", next, oldPath: current.relativePath, oldHash: current.contentHash, tempPath, change };
    this.runPending(pending, () => {
      if (targetPath === current.relativePath) this.writeReplace(targetPath, tempPath, body, current.contentHash);
      else this.writeNew(targetPath, tempPath, body);
    });
    const document = this.snapshot().documents.find((entry) => entry.id === id);
    if (!document) throw new VaultStorageError("Updated note was not visible after its durable commit.");
    return { document, change };
  }

  deleteDocument(id: string, expectedVersion: number, expectedHash?: string): ChangeRecord {
    const current = this.getDocumentMeta(id);
    if (!current) throw new VaultStorageError("Note not found.", "not_found", 404);
    const info = this.fileInfo(current.relativePath);
    if (current.version !== expectedVersion || info.contentHash !== current.contentHash || (expectedHash && expectedHash !== current.contentHash)) {
      throw new VaultVersionConflictError(current.version, info.contentHash);
    }
    const now = new Date().toISOString();
    const change = eventFor(this.state, "document", id, current.title, "deleted", current.version + 1, now);
    const pending: PendingOperation = { kind: "document-delete", id, title: current.title, oldPath: current.relativePath, oldHash: current.contentHash, nextVersion: current.version + 1, change };
    this.runPending(pending, () => {
      const currentInfo = this.fileInfo(current.relativePath);
      if (currentInfo.contentHash !== current.contentHash) throw new VaultVersionConflictError(current.version, currentInfo.contentHash);
      unlinkSync(this.safeAbsolute(current.relativePath));
      fsyncDirectory(path.dirname(this.safeAbsolute(current.relativePath)));
    });
    return change;
  }

  trashDocument(id: string, expectedVersion: number, expectedHash?: string): VisualizationTrashNote {
    const current = this.getDocumentMeta(id);
    if (!current) throw new VaultStorageError("Note not found.", "not_found", 404);
    const info = this.fileInfo(current.relativePath);
    if (current.version !== expectedVersion || info.contentHash !== current.contentHash || (expectedHash && expectedHash !== current.contentHash)) {
      throw new VaultVersionConflictError(current.version, info.contentHash);
    }
    const trashedAt = new Date().toISOString();
    const trashPath = `.fieldnotes/trash/${id}.md`;
    const change = eventFor(this.state, "document", id, current.title, "deleted", current.version + 1, trashedAt);
    const pending: PendingOperation = {
      kind: "document-trash", id, oldPath: current.relativePath, oldHash: current.contentHash,
      trashPath, trashedAt, nextVersion: current.version + 1, change,
    };
    this.runPending(pending, () => {
      const currentInfo = this.fileInfo(current.relativePath);
      if (currentInfo.contentHash !== current.contentHash) throw new VaultVersionConflictError(current.version, currentInfo.contentHash);
      const source = this.safeAbsolute(current.relativePath);
      const target = this.safeTrashAbsolute(id, true);
      if (existsSync(target)) throw new VaultStorageError("A trash entry already exists for this note id.", "vault_state_conflict", 409);
      renameSync(source, target);
      fsyncDirectory(path.dirname(source));
      fsyncDirectory(path.dirname(target));
    });
    const meta = this.state.trashedDocuments.find((note) => note.id === id);
    const trashInfo = meta ? this.trashFileInfo(id) : undefined;
    if (!meta || !trashInfo) throw new VaultStorageError("Trashed note was not visible after its durable commit.");
    return {
      id,
      title: meta.title,
      folderId: meta.folderId,
      trashedAt: meta.trashedAt,
      version: meta.version,
      excerpt: excerptFromMarkdown(trashInfo.body, 150),
    };
  }

  restoreTrashedDocument(id: string, expectedVersion: number): { document: DocumentRecord; change: ChangeRecord } {
    const current = this.state.trashedDocuments.find((document) => document.id === id);
    if (!current) throw new VaultStorageError("Trashed note not found.", "not_found", 404);
    const info = this.trashFileInfo(id);
    if (!info || current.version !== expectedVersion || info.contentHash !== current.contentHash) {
      throw new VaultVersionConflictError(current.version, info?.contentHash ?? "0".repeat(64));
    }
    const folderId = current.folderId !== null && this.getFolderMeta(current.folderId) ? current.folderId : null;
    const relativePath = this.notePath(current.title, id, folderId);
    const updatedAt = new Date().toISOString();
    const next: Omit<VaultDocumentMeta, keyof FileKey> = {
      id: current.id,
      title: current.title,
      folderId,
      relativePath,
      createdAt: current.createdAt,
      updatedAt,
      version: current.version + 1,
      contentHash: current.contentHash,
    };
    const change = eventFor(this.state, "document", id, current.title, "created", next.version, updatedAt);
    const pending: PendingOperation = { kind: "document-restore", id, trashPath: current.trashPath, next, change };
    this.runPending(pending, () => {
      const currentInfo = this.trashFileInfo(id);
      if (!currentInfo || currentInfo.contentHash !== current.contentHash) {
        throw new VaultVersionConflictError(current.version, currentInfo?.contentHash ?? "0".repeat(64));
      }
      const source = this.safeTrashAbsolute(id);
      const target = this.safeAbsolute(relativePath, true);
      if (existsSync(target)) throw new VaultStorageError("The restore destination already exists; the note was left in trash.", "vault_name_collision", 409);
      renameSync(source, target);
      fsyncDirectory(path.dirname(source));
      fsyncDirectory(path.dirname(target));
    });
    const document = this.snapshot().documents.find((entry) => entry.id === id);
    if (!document) throw new VaultStorageError("Restored note was not visible after its durable commit.");
    return { document, change };
  }

  createFolder(name: string, parentId: string | null): { folder: FolderRecord; change: ChangeRecord } {
    if (parentId !== null && !this.getFolderMeta(parentId)) throw new VaultStorageError("Folder not found.", "not_found", 404);
    const parent = this.relativeForFolderId(parentId);
    this.assertSiblingAvailable(parent, name);
    const id = randomUUID();
    const now = new Date().toISOString();
    const rel = relativePath(parent, name);
    const next: Omit<VaultFolderMeta, keyof FileKey> = { id, name, parentId, relativePath: rel, createdAt: now, updatedAt: now, version: 1 };
    const change = eventFor(this.state, "folder", id, name, "created", 1, now);
    const pending: PendingOperation = { kind: "folder-create", next, change };
    this.runPending(pending, () => {
      const target = this.safeAbsolute(rel, true);
      mkdirSync(target, { recursive: false, mode: 0o700 });
      fsyncDirectory(path.dirname(target));
    });
    const folder = this.snapshot().folders.find((entry) => entry.id === id);
    if (!folder) throw new VaultStorageError("Created folder was not visible after its durable commit.");
    return { folder, change };
  }

  updateFolder(
    id: string,
    expectedVersion: number,
    changes: { name?: string; parentId?: string | null },
  ): { folder: FolderRecord; change?: ChangeRecord } {
    const current = this.getFolderMeta(id);
    if (!current) throw new VaultStorageError("Folder not found.", "not_found", 404);
    if (current.version !== expectedVersion) throw new VaultStorageError("Folder changed on disk. Refresh it before saving.", "version_conflict", 409);
    const name = changes.name ?? current.name;
    const parentId = changes.parentId === undefined ? current.parentId : changes.parentId;
    if (parentId !== null && !this.getFolderMeta(parentId)) throw new VaultStorageError("Parent folder not found.", "not_found", 404);
    let ancestor = parentId;
    while (ancestor) {
      if (ancestor === id) throw new VaultStorageError("A folder cannot be moved inside itself or a descendant.", "folder_cycle", 409);
      ancestor = this.getFolderMeta(ancestor)?.parentId ?? null;
    }
    const parent = this.relativeForFolderId(parentId);
    const target = relativePath(parent, name);
    this.assertSiblingAvailable(parent, name, current.relativePath);
    if (target === current.relativePath && name === current.name && parentId === current.parentId) {
      const folder = this.snapshot().folders.find((entry) => entry.id === id);
      if (!folder) throw new VaultStorageError("Folder was not visible in the vault.");
      return { folder };
    }
    const now = new Date().toISOString();
    const next: Omit<VaultFolderMeta, keyof FileKey> = {
      id, name, parentId, relativePath: target, createdAt: current.createdAt, updatedAt: now, version: current.version + 1,
    };
    const change = eventFor(this.state, "folder", id, name, "updated", next.version, now);
    const caseOnly = normalizedRelativeKey(target) === normalizedRelativeKey(current.relativePath) && target !== current.relativePath;
    const tempPath = caseOnly ? relativePath(parentPath(current.relativePath), `${TEMP_PREFIX}${randomUUID()}`) : undefined;
    const pending: PendingOperation = { kind: "folder-update", next, oldPath: current.relativePath, ...(tempPath ? { tempPath } : {}), change };
    this.runPending(pending, () => {
      const oldAbsolute = this.safeAbsolute(current.relativePath);
      const targetAbsolute = this.safeAbsolute(target, true);
      if (statKind(oldAbsolute) !== "directory") throw new VaultStorageError("Folder changed on disk before rename.", "vault_external_conflict", 409);
      if (tempPath) {
        renameSync(oldAbsolute, this.safeAbsolute(tempPath, true));
        fsyncDirectory(path.dirname(oldAbsolute));
        renameSync(this.safeAbsolute(tempPath), targetAbsolute);
      } else {
        if (this.pathExists(target)) throw new VaultStorageError("A folder already exists at the destination.", "vault_name_collision", 409);
        renameSync(oldAbsolute, targetAbsolute);
      }
      fsyncDirectory(path.dirname(oldAbsolute));
      fsyncDirectory(path.dirname(targetAbsolute));
    });
    const folder = this.snapshot().folders.find((entry) => entry.id === id);
    if (!folder) throw new VaultStorageError("Updated folder was not visible after its durable commit.");
    return { folder, change };
  }

  deleteFolder(id: string, expectedVersion: number): ChangeRecord {
    const current = this.getFolderMeta(id);
    if (!current) throw new VaultStorageError("Folder not found.", "not_found", 404);
    if (current.version !== expectedVersion) throw new VaultStorageError("Folder changed on disk. Refresh it before deleting.", "version_conflict", 409);
    const absolute = this.safeAbsolute(current.relativePath);
    if (readdirSync(absolute).length) throw new VaultStorageError("This folder contains notes, subfolders, or other files.", "folder_not_empty", 409);
    const now = new Date().toISOString();
    const change = eventFor(this.state, "folder", id, current.name, "deleted", current.version + 1, now);
    const pending: PendingOperation = { kind: "folder-delete", id, name: current.name, oldPath: current.relativePath, nextVersion: current.version + 1, change };
    this.runPending(pending, () => {
      if (readdirSync(this.safeAbsolute(current.relativePath)).length) throw new VaultStorageError("This folder is no longer empty.", "folder_not_empty", 409);
      rmdirSync(this.safeAbsolute(current.relativePath));
      fsyncDirectory(path.dirname(absolute));
    });
    return change;
  }

  importDocuments(items: Array<{ title: string; body: string; folderId?: string | null }>): DocumentRecord[] {
    const created: DocumentRecord[] = [];
    try {
      for (const item of items) created.push(this.createDocument(item.title, item.body, item.folderId ?? null).document);
      return created;
    } catch (error) {
      // Completed imports remain durable and visible. The error message makes partial
      // completion explicit instead of deleting any already committed Markdown files.
      if (created.length) throw new VaultStorageError(`Imported ${created.length} files before the next file failed: ${(error as Error).message}`, "partial_import", 409);
      throw error;
    }
  }
}
