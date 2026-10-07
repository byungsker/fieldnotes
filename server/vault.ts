import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  chmodSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { excerptFromMarkdown } from "./markdown.js";
import type { ChangeRecord, DocumentRecord, FolderRecord } from "./types.js";

const STATE_FILE = "state.json";
const STATE_FORMAT = "fieldnotes-vault";
const STATE_VERSION = 1;
const TEMP_PREFIX = ".fieldnotes-tmp-";
const MAX_VAULT_FILE_BYTES = 5_000_000;

export class VaultStorageError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "vault_unavailable", status = 503) {
    super(message);
    this.name = "VaultStorageError";
    this.code = code;
    this.status = status;
  }
}

export class VaultVersionConflictError extends VaultStorageError {
  readonly currentVersion: number;
  readonly currentHash: string;

  constructor(currentVersion: number, currentHash: string) {
    super("The Markdown file changed on disk. Load the latest version before saving again.", "version_conflict", 409);
    this.name = "VaultVersionConflictError";
    this.currentVersion = currentVersion;
    this.currentHash = currentHash;
  }
}

type FileKey = { device: string; inode: string };

export type VaultDocumentMeta = FileKey & {
  id: string;
  title: string;
  folderId: string | null;
  relativePath: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  contentHash: string;
};

export type VaultFolderMeta = FileKey & {
  id: string;
  name: string;
  parentId: string | null;
  relativePath: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

type PendingBase = { change: ChangeRecord };
type PendingOperation = PendingBase & (
  | { kind: "document-create"; next: Omit<VaultDocumentMeta, keyof FileKey>; tempPath: string }
  | { kind: "document-update"; next: Omit<VaultDocumentMeta, keyof FileKey>; oldPath: string; oldHash: string; tempPath: string }
  | { kind: "document-delete"; id: string; title: string; oldPath: string; oldHash: string; nextVersion: number }
  | { kind: "folder-create"; next: Omit<VaultFolderMeta, keyof FileKey> }
  | { kind: "folder-update"; next: Omit<VaultFolderMeta, keyof FileKey>; oldPath: string; tempPath?: string }
  | { kind: "folder-delete"; id: string; name: string; oldPath: string; nextVersion: number }
);

export type VaultState = {
  format: typeof STATE_FORMAT;
  schemaVersion: typeof STATE_VERSION;
  vaultId: string;
  sequence: number;
  documents: VaultDocumentMeta[];
  folders: VaultFolderMeta[];
  changes: ChangeRecord[];
  pending?: PendingOperation;
};

export type VaultSnapshot = {
  vaultId: string;
  sequence: number;
  documents: DocumentRecord[];
  folders: FolderRecord[];
  changes: ChangeRecord[];
};

export type LegacyDocument = {
  id: string;
  title: string;
  body: string;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type LegacyFolder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

type ScannedFolder = FileKey & { name: string; relativePath: string; parentPath: string };
type ScannedDocument = FileKey & {
  name: string;
  relativePath: string;
  parentPath: string;
  body: string;
  contentHash: string;
  byteLength: number;
};

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileKey(absolutePath: string): FileKey {
  const stat = lstatSync(absolutePath, { bigint: true });
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

function statKind(absolutePath: string): "file" | "directory" | "symlink" | "other" {
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function normalizedNameKey(value: string): string {
  return value.normalize("NFD").toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ").replace(/[ .]+$/u, "");
}

function normalizedRelativeKey(value: string): string {
  return value.split("/").map(normalizedNameKey).join("/");
}

function relativePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentPath(value: string): string {
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
}

function basename(value: string): string {
  const index = value.lastIndexOf("/");
  return index < 0 ? value : value.slice(index + 1);
}

function titleFromFileName(name: string, id?: string): string {
  let stem = name.replace(/\.(?:md|markdown)$/i, "");
  if (id) {
    const suffix = `--${id.slice(0, 8)}`;
    if (stem.endsWith(suffix)) stem = stem.slice(0, -suffix.length);
  }
  try {
    return decodeURIComponent(stem) || "Untitled";
  } catch {
    return stem || "Untitled";
  }
}

function encodedNameTokens(title: string): string[] {
  const chars = [...title.normalize("NFC")];
  return chars.map((character, index) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const encode = /[%/\\:*?"<>|]/u.test(character)
      || codePoint < 32
      || codePoint === 127
      || (index === 0 && character === ".")
      || (index === chars.length - 1 && (character === "." || character === " "));
    if (!encode) return character;
    return [...Buffer.from(character, "utf8")].map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`).join("");
  });
}

function truncateTokens(tokens: string[], maxBytes: number): string {
  let result = "";
  let length = 0;
  for (const token of tokens) {
    const bytes = Buffer.byteLength(token, "utf8");
    if (length + bytes > maxBytes) break;
    result += token;
    length += bytes;
  }
  return result;
}

function safeNoteFileName(title: string, id: string, collision = false): string {
  const tokens = encodedNameTokens(title);
  const base = tokens.join("") || "Untitled";
  const useSuffix = collision || Buffer.byteLength(`${base}.md`, "utf8") > 220;
  const suffix = useSuffix ? `--${id.slice(0, 8)}` : "";
  const stem = useSuffix ? `${truncateTokens(tokens, 190) || "Untitled"}${suffix}` : base;
  return `${stem}.md`;
}

function safeFolderSegment(name: string, id: string, collision = false): string {
  const tokens = encodedNameTokens(name);
  const base = tokens.join("") || "Folder";
  const useSuffix = collision || Buffer.byteLength(base, "utf8") > 200 || base.startsWith(TEMP_PREFIX);
  const suffix = useSuffix ? `--${id.slice(0, 8)}` : "";
  return useSuffix ? `${truncateTokens(tokens, 170) || "Folder"}${suffix}` : base;
}

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

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Some filesystems do not support fsync on directories. File contents are still fsynced.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeAtomic(absolutePath: string, bytes: Buffer): void {
  const directory = path.dirname(absolutePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `${TEMP_PREFIX}${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, absolutePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function writeNewDurable(absolutePath: string, bytes: Buffer, mode = 0o600): void {
  const directory = path.dirname(absolutePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(absolutePath, "wx", mode);
    created = true;
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created && existsSync(absolutePath)) unlinkSync(absolutePath);
    throw error;
  }
}

function readRegularFileNoFollow(absolutePath: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new VaultStorageError("Expected a regular file; symbolic links are not followed.", "vault_symlink", 409);
    if (stat.size > MAX_VAULT_FILE_BYTES) throw new VaultStorageError(`Markdown file exceeds the ${MAX_VAULT_FILE_BYTES} byte vault limit.`, "vault_file_too_large", 409);
    return readFileSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new VaultStorageError("Symbolic links are not allowed inside a Fieldnotes vault.", "vault_symlink", 409);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function exactEntryExists(parentAbsolute: string, name: string): boolean {
  try {
    return readdirSync(parentAbsolute).includes(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVaultPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\u0000")
    && !/^[A-Za-z]:/.test(value)
    && !value.split("/").some((segment) => !segment || segment === "." || segment === ".." || normalizedNameKey(segment) === ".fieldnotes");
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isFileKey(value: Record<string, unknown>): boolean {
  return typeof value.device === "string" && /^\d+$/.test(value.device)
    && typeof value.inode === "string" && /^\d+$/.test(value.inode);
}

function isChange(value: unknown): value is ChangeRecord {
  if (!isRecord(value) || !Number.isSafeInteger(value.seq) || Number(value.seq) < 1
    || (value.entityType !== "document" && value.entityType !== "folder")
    || typeof value.title !== "string"
    || !["created", "updated", "deleted"].includes(String(value.operation))
    || !Number.isSafeInteger(value.version) || Number(value.version) < 1
    || !isTimestamp(value.createdAt)) return false;
  return value.entityType === "folder"
    ? typeof value.folderId === "string" && UUID_PATTERN.test(value.folderId)
    : typeof value.documentId === "string" && UUID_PATTERN.test(value.documentId);
}

function isPendingOperation(value: unknown, sequence: number): value is PendingOperation {
  if (!isRecord(value) || !isChange(value.change) || value.change.seq !== sequence + 1) return false;
  const pathFields = (fields: string[]) => fields.every((field) => isVaultPath(value[field]));
  if (value.kind === "document-create" || value.kind === "document-update") {
    if (!isRecord(value.next) || !UUID_PATTERN.test(String(value.next.id))
      || typeof value.next.title !== "string"
      || (value.next.folderId !== null && !UUID_PATTERN.test(String(value.next.folderId)))
      || !isVaultPath(value.next.relativePath)
      || !isTimestamp(value.next.createdAt) || !isTimestamp(value.next.updatedAt)
      || !Number.isSafeInteger(value.next.version) || !/^[0-9a-f]{64}$/i.test(String(value.next.contentHash))) return false;
    return value.kind === "document-create"
      ? pathFields(["tempPath"])
      : pathFields(["oldPath", "tempPath"]) && /^[0-9a-f]{64}$/i.test(String(value.oldHash));
  }
  if (value.kind === "document-delete") {
    return UUID_PATTERN.test(String(value.id)) && typeof value.title === "string"
      && pathFields(["oldPath"]) && /^[0-9a-f]{64}$/i.test(String(value.oldHash));
  }
  if (value.kind === "folder-create" || value.kind === "folder-update") {
    if (!isRecord(value.next) || !UUID_PATTERN.test(String(value.next.id))
      || typeof value.next.name !== "string"
      || (value.next.parentId !== null && !UUID_PATTERN.test(String(value.next.parentId)))
      || !isVaultPath(value.next.relativePath)
      || !isTimestamp(value.next.createdAt) || !isTimestamp(value.next.updatedAt)
      || !Number.isSafeInteger(value.next.version)) return false;
    if (value.kind === "folder-create") return true;
    return pathFields(["oldPath"]) && (value.tempPath === undefined || isVaultPath(value.tempPath));
  }
  if (value.kind === "folder-delete") return UUID_PATTERN.test(String(value.id)) && pathFields(["oldPath"]);
  return false;
}

function shallowState(value: unknown): value is VaultState {
  if (!isRecord(value) || value.format !== STATE_FORMAT || value.schemaVersion !== STATE_VERSION
    || typeof value.vaultId !== "string" || !UUID_PATTERN.test(value.vaultId)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0
    || !Array.isArray(value.documents) || !Array.isArray(value.folders) || !Array.isArray(value.changes)) return false;
  const documentsValid = value.documents.every((entry) => isRecord(entry)
    && UUID_PATTERN.test(String(entry.id)) && typeof entry.title === "string"
    && (entry.folderId === null || UUID_PATTERN.test(String(entry.folderId)))
    && isVaultPath(entry.relativePath) && isTimestamp(entry.createdAt) && isTimestamp(entry.updatedAt)
    && Number.isSafeInteger(entry.version) && Number(entry.version) >= 1
    && /^[0-9a-f]{64}$/i.test(String(entry.contentHash)) && isFileKey(entry));
  const foldersValid = value.folders.every((entry) => isRecord(entry)
    && UUID_PATTERN.test(String(entry.id)) && typeof entry.name === "string"
    && (entry.parentId === null || UUID_PATTERN.test(String(entry.parentId)))
    && isVaultPath(entry.relativePath) && isTimestamp(entry.createdAt) && isTimestamp(entry.updatedAt)
    && Number.isSafeInteger(entry.version) && Number(entry.version) >= 1 && isFileKey(entry));
  const changesValid = value.changes.every(isChange)
    && value.changes.every((change) => change.seq <= Number(value.sequence));
  const uniqueIds = (entries: unknown[]) => new Set(entries.map((entry) => isRecord(entry) ? entry.id : undefined)).size === entries.length;
  const relativePaths = [...value.documents, ...value.folders].map((entry) => isRecord(entry) ? normalizedRelativeKey(String(entry.relativePath)) : "");
  const uniquePaths = new Set(relativePaths).size === relativePaths.length;
  const changeSequences = value.changes.map((change) => isRecord(change) ? Number(change.seq) : -1);
  const orderedUniqueChanges = new Set(changeSequences).size === changeSequences.length
    && changeSequences.every((sequence, index) => index === 0 || sequence > changeSequences[index - 1]);
  const pendingValid = value.pending === undefined || isPendingOperation(value.pending, Number(value.sequence));
  return documentsValid && foldersValid && changesValid && uniqueIds(value.documents) && uniqueIds(value.folders)
    && uniquePaths && orderedUniqueChanges && pendingValid;
}

export class FileVault {
  readonly rootDir: string;
  readonly metadataDir: string;
  readonly statePath: string;
  private state: VaultState;

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
      if (!shallowState(parsed)) throw new VaultStorageError("Vault metadata has an unsupported format; original Markdown files were left untouched.", "vault_state_invalid", 409);
      this.state = parsed;
    } else {
      this.state = {
        format: STATE_FORMAT,
        schemaVersion: STATE_VERSION,
        vaultId: randomUUID(),
        sequence: 0,
        documents: [],
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

  getFolderMeta(id: string): VaultFolderMeta | undefined {
    return this.state.folders.find((folder) => folder.id === id);
  }

  getDocumentPath(id: string): string | undefined {
    return this.getDocumentMeta(id)?.relativePath;
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

  private fileInfo(relative: string): { body: string; contentHash: string; key: FileKey; byteLength: number } {
    const absolute = this.safeAbsolute(relative);
    if (statKind(absolute) !== "file") throw new VaultStorageError("Expected a regular Markdown file.", "vault_entry_invalid", 409);
    const bytes = readRegularFileNoFollow(absolute);
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

  createDocument(title: string, body: string, folderId: string | null): { document: DocumentRecord; change: ChangeRecord } {
    if (body.length > 250_000) throw new VaultStorageError("Markdown body is too large (250 KB maximum).", "vault_file_too_large", 400);
    if (folderId !== null && !this.getFolderMeta(folderId)) throw new VaultStorageError("Folder not found.", "not_found", 404);
    const id = randomUUID();
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

export function createVaultFromLegacy(
  root: string,
  documents: LegacyDocument[],
  folders: LegacyFolder[],
  changes: ChangeRecord[],
  migrationManifestPath: string,
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
    || new Set(folders.map((folder) => folder.id)).size !== folders.length) {
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

  const vaultId = randomUUID();
  const sequence = changes.reduce((maximum, change) => Math.max(maximum, change.seq), 0);
  const state: VaultState = {
    format: STATE_FORMAT,
    schemaVersion: STATE_VERSION,
    vaultId,
    sequence,
    documents: documentMetas,
    folders: folderMetas,
    changes: [...changes].sort((left, right) => left.seq - right.seq),
  };
  writeAtomic(path.join(metadata, STATE_FILE), Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8"));
  fsyncDirectory(staging);
  const manifest = {
    format: "fieldnotes-migration-manifest",
    createdAt: new Date().toISOString(),
    vaultId,
    sourceCounts: { documents: documents.length, folders: folders.length, changes: changes.length },
    documents: migrationDocuments,
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
