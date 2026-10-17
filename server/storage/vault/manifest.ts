import type { ChangeRecord } from "../types.js";
import { STATE_FORMAT, STATE_VERSION, UUID_PATTERN } from "./constants.js";
import { normalizedNameKey, normalizedRelativeKey } from "./paths.js";
import type { PendingOperation, VaultState } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
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

function isTrashPath(value: unknown, id: unknown): value is string {
  return typeof id === "string" && UUID_PATTERN.test(id) && value === `.fieldnotes/trash/${id}.md`;
}

export function isTimestamp(value: unknown): value is string {
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
  if (value.kind === "document-trash") {
    return UUID_PATTERN.test(String(value.id)) && pathFields(["oldPath"])
      && isTrashPath(value.trashPath, value.id) && /^[0-9a-f]{64}$/i.test(String(value.oldHash))
      && isTimestamp(value.trashedAt) && Number.isSafeInteger(value.nextVersion) && Number(value.nextVersion) >= 2;
  }
  if (value.kind === "document-restore") {
    if (!UUID_PATTERN.test(String(value.id)) || !isTrashPath(value.trashPath, value.id) || !isRecord(value.next)) return false;
    return value.next.id === value.id && typeof value.next.title === "string"
      && (value.next.folderId === null || UUID_PATTERN.test(String(value.next.folderId)))
      && isVaultPath(value.next.relativePath) && isTimestamp(value.next.createdAt) && isTimestamp(value.next.updatedAt)
      && Number.isSafeInteger(value.next.version) && Number(value.next.version) >= 2
      && /^[0-9a-f]{64}$/i.test(String(value.next.contentHash));
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

export function shallowState(value: unknown): value is VaultState {
  if (!isRecord(value) || value.format !== STATE_FORMAT || value.schemaVersion !== STATE_VERSION
    || typeof value.vaultId !== "string" || !UUID_PATTERN.test(value.vaultId)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0
    || !Array.isArray(value.documents) || !Array.isArray(value.trashedDocuments) || !Array.isArray(value.folders) || !Array.isArray(value.changes)) return false;
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
  const trashValid = value.trashedDocuments.every((entry) => isRecord(entry)
    && UUID_PATTERN.test(String(entry.id)) && typeof entry.title === "string"
    && (entry.folderId === null || UUID_PATTERN.test(String(entry.folderId)))
    && isVaultPath(entry.relativePath) && isTrashPath(entry.trashPath, entry.id)
    && isTimestamp(entry.createdAt) && isTimestamp(entry.updatedAt) && isTimestamp(entry.trashedAt)
    && Number.isSafeInteger(entry.version) && Number(entry.version) >= 1
    && /^[0-9a-f]{64}$/i.test(String(entry.contentHash)) && isFileKey(entry));
  const changesValid = value.changes.every(isChange)
    && value.changes.every((change) => change.seq <= Number(value.sequence));
  const uniqueIds = (entries: unknown[]) => new Set(entries.map((entry) => isRecord(entry) ? entry.id : undefined)).size === entries.length;
  const relativePaths = [...value.documents, ...value.folders].map((entry) => isRecord(entry) ? normalizedRelativeKey(String(entry.relativePath)) : "");
  const uniquePaths = new Set(relativePaths).size === relativePaths.length;
  const changeSequences = value.changes.map((change) => isRecord(change) ? Number(change.seq) : -1);
  const orderedUniqueChanges = new Set(changeSequences).size === changeSequences.length
    && changeSequences.every((sequence, index) => index === 0 || sequence > changeSequences[index - 1]);
  const pendingValid = value.pending === undefined || isPendingOperation(value.pending, Number(value.sequence));
  return documentsValid && foldersValid && trashValid && changesValid
    && uniqueIds([...value.documents, ...value.trashedDocuments]) && uniqueIds(value.folders)
    && uniquePaths && orderedUniqueChanges && pendingValid;
}
