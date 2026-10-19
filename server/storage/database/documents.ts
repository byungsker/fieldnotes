import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { excerptFromMarkdown, extractWikilinkTargets, normalizeTitle } from "../markdown.js";
import type { ChangeRecord, DocumentRecord, DocumentSummary } from "../types.js";
import type { VisualizationTrashNote } from "../../../shared/visualization.js";
import { ViewQueryLimitError, VIEW_TRASH_LIMIT_MESSAGE } from "../../view-query-limits.js";
import { VaultStorageError, VaultVersionConflictError } from "../vault.js";
import type { KnowledgeDatabase, SqlRow } from "./context.js";
import { MissingDocumentError, VersionConflictError } from "./errors.js";
import { insertChange, transact } from "./changes.js";
import { getFolder, requireFolder } from "./folders.js";
import { mapDocument, mapSummary } from "./records.js";
import { applyVaultDocumentRead, rebuildVaultIndex } from "./vault-index.js";

export function listDocuments(db: DatabaseSync, query = "", folderId?: string | null): DocumentSummary[] {
  const value = query.trim();
  const clauses: string[] = [];
  const parameters: Array<string | null> = [];
  if (value) {
    clauses.push("(instr(lower(title), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0)");
    parameters.push(value, value);
  }
  if (folderId !== undefined) {
    clauses.push(folderId === null ? "folder_id IS NULL" : "folder_id = ?");
    if (folderId !== null) parameters.push(folderId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT id, title, folder_id, file_path, content_hash, created_at, updated_at, version, body AS excerpt_source FROM documents ${where} ORDER BY updated_at DESC, title COLLATE NOCASE ASC`)
    .all(...parameters) as SqlRow[];
  return rows.map((row) =>
    mapSummary({ ...row, excerpt: excerptFromMarkdown(String(row.excerpt_source ?? ""), 150, value) }),
  );
}

export function getDocument(db: DatabaseSync, id: string): DocumentRecord | undefined {
  const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as SqlRow | undefined;
  return row ? mapDocument(row) : undefined;
}

export function readCurrentDocument(database: KnowledgeDatabase, id: string): DocumentRecord | undefined {
  if (!database.vault) return getDocument(database.db, id);
  const result = database.vault.readDocument(id);
  applyVaultDocumentRead(database, result);
  return result.document;
}

export function listTrashDocuments(db: DatabaseSync, limit = 500, maxBytes = Number.MAX_SAFE_INTEGER): VisualizationTrashNote[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 500) throw new RangeError("Trash query limit must be between 0 and 500.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Trash query byte limit is invalid.");
  const candidates = db.prepare(`
    SELECT id, title, folder_id, trashed_at, version, length(CAST(body AS BLOB)) AS body_bytes
    FROM trash_documents ORDER BY trashed_at DESC LIMIT ?
  `).all(limit) as SqlRow[];
  const readBody = db.prepare("SELECT body FROM trash_documents WHERE id = ?");
  const notes: VisualizationTrashNote[] = [];
  let scannedBytes = 0;
  for (const candidate of candidates) {
    const byteLength = Number(candidate.body_bytes ?? 0);
    if (scannedBytes + byteLength > maxBytes) {
      throw new ViewQueryLimitError(VIEW_TRASH_LIMIT_MESSAGE);
    }
    const bodyRow = readBody.get(candidate.id) as SqlRow | undefined;
    scannedBytes += byteLength;
    notes.push({
      id: String(candidate.id),
      title: String(candidate.title),
      folderId: candidate.folder_id === null || candidate.folder_id === undefined ? null : String(candidate.folder_id),
      trashedAt: String(candidate.trashed_at),
      version: Number(candidate.version),
      excerpt: excerptFromMarkdown(String(bodyRow?.body ?? ""), 150),
    });
  }
  return notes;
}

export function listTrashedDocuments(database: KnowledgeDatabase, limit = 500, maxBytes = Number.MAX_SAFE_INTEGER): VisualizationTrashNote[] {
  return database.vault ? database.vault.listTrashedDocuments(limit, maxBytes) : listTrashDocuments(database.db, limit, maxBytes);
}

export function trashDocument(database: KnowledgeDatabase, id: string, expectedVersion: number, expectedHash?: string): VisualizationTrashNote {
  if (database.vault) {
    const current = getDocument(database.db, id);
    if (!current) throw new MissingDocumentError();
    if (current.version !== expectedVersion || (expectedHash && current.contentHash && expectedHash !== current.contentHash)) {
      throw new VersionConflictError(current.version, current.contentHash);
    }
    try {
      const trashed = database.vault.trashDocument(id, expectedVersion, expectedHash);
      rebuildVaultIndex(database);
      return trashed;
    } catch (error) {
      if (error instanceof VaultVersionConflictError) throw new VersionConflictError(error.currentVersion, error.currentHash);
      throw error;
    }
  } else {
    transact(database, () => {
      const current = getDocument(database.db, id);
      if (!current) throw new MissingDocumentError();
      const contentHash = current.contentHash || createHash("sha256").update(current.body, "utf8").digest("hex");
      if (current.version !== expectedVersion || (expectedHash && expectedHash !== contentHash)) throw new VersionConflictError(current.version, contentHash);
      const trashedAt = new Date().toISOString();
      database.db.prepare(`
        INSERT INTO trash_documents (id, title, body, folder_id, file_path, content_hash, created_at, updated_at, trashed_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(current.id, current.title, current.body, current.folderId, current.filePath ?? "", contentHash, current.createdAt, current.updatedAt, trashedAt, current.version);
      database.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
      const change = insertChange(database.db, id, current.title, "deleted", current.version + 1, trashedAt);
      return { value: undefined, change };
    });
  }
  const row = database.db.prepare("SELECT id, title, folder_id, trashed_at, version, body FROM trash_documents WHERE id = ?").get(id) as SqlRow | undefined;
  if (!row) throw new MissingDocumentError();
  return {
    id: String(row.id),
    title: String(row.title),
    folderId: row.folder_id === null || row.folder_id === undefined ? null : String(row.folder_id),
    trashedAt: String(row.trashed_at),
    version: Number(row.version),
    excerpt: excerptFromMarkdown(String(row.body ?? ""), 150),
  };
}

export function restoreTrashedDocument(database: KnowledgeDatabase, id: string, expectedVersion: number): DocumentRecord {
  if (database.vault) {
    try {
      const result = database.vault.restoreTrashedDocument(id, expectedVersion);
      rebuildVaultIndex(database);
      return getDocument(database.db, id) ?? result.document;
    } catch (error) {
      if (error instanceof VaultVersionConflictError) throw new VersionConflictError(error.currentVersion, error.currentHash);
      if (error instanceof VaultStorageError && error.status === 404) throw new MissingDocumentError();
      throw error;
    }
  }
  return transact(database, () => {
    const row = database.db.prepare("SELECT * FROM trash_documents WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) throw new MissingDocumentError();
    const currentVersion = Number(row.version);
    if (currentVersion !== expectedVersion) throw new VersionConflictError(currentVersion, String(row.content_hash ?? ""));
    const requestedFolderId = row.folder_id === null || row.folder_id === undefined ? null : String(row.folder_id);
    const folderId = requestedFolderId && !getFolder(database.db, requestedFolderId) ? null : requestedFolderId;
    const version = currentVersion + 1;
    const timestamp = new Date().toISOString();
    database.db.prepare(`
      INSERT INTO documents (id, title, body, folder_id, file_path, content_hash, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.title, row.body, folderId, row.file_path, row.content_hash, row.created_at, timestamp, version);
    database.db.prepare("DELETE FROM trash_documents WHERE id = ?").run(id);
    const change = insertChange(database.db, id, String(row.title), "created", version, timestamp);
    return { value: getDocument(database.db, id) as DocumentRecord, change };
  });
}

export function createDocument(
  database: KnowledgeDatabase,
  title: string,
  body: string,
  folderId: string | null = null,
  requestedId?: string,
): DocumentRecord {
  const id = requestedId ?? randomUUID();
  if (requestedId) {
    const existing = getDocument(database.db, id);
    if (existing) return existing;
    const priorCreate = database.db.prepare(
      "SELECT 1 AS present FROM changes WHERE document_id = ? AND entity_type = 'document' AND operation = 'created' LIMIT 1",
    ).get(id);
    if (priorCreate) throw new MissingDocumentError();
  }
  if (database.vault) {
    const result = database.vault.createDocument(title, body, folderId, id);
    rebuildVaultIndex(database);
    return getDocument(database.db, result.document.id) ?? result.document;
  }
  const timestamp = new Date().toISOString();
  return transact(database, () => {
    if (folderId !== null) requireFolder(database.db, folderId);
    database.db
      .prepare("INSERT INTO documents (id, title, body, folder_id, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)")
      .run(id, title, body, folderId, timestamp, timestamp);
    const change = insertChange(database.db, id, title, "created", 1, timestamp);
    return { value: getDocument(database.db, id) as DocumentRecord, change };
  });
}

export function updateDocument(
  database: KnowledgeDatabase,
  id: string,
  expectedVersion: number,
  title: string,
  body: string,
  folderId?: string | null,
  expectedHash?: string,
): DocumentRecord {
  if (database.vault) {
    const current = getDocument(database.db, id);
    if (!current) throw new MissingDocumentError();
    if (current.version !== expectedVersion || (expectedHash && current.contentHash && expectedHash !== current.contentHash)) {
      throw new VersionConflictError(current.version, current.contentHash);
    }
    try {
      const result = database.vault.updateDocument(id, expectedVersion, expectedHash, title, body, folderId);
      rebuildVaultIndex(database);
      return getDocument(database.db, id) ?? result.document;
    } catch (error) {
      if (error instanceof VaultVersionConflictError) throw new VersionConflictError(error.currentVersion, error.currentHash);
      throw error;
    }
  }
  return transact(database, () => {
    const current = getDocument(database.db, id);
    if (!current) throw new MissingDocumentError();
    if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
    const nextFolderId = folderId === undefined ? current.folderId : folderId;
    if (nextFolderId !== null) requireFolder(database.db, nextFolderId);
    const timestamp = new Date().toISOString();
    const version = current.version + 1;
    database.db
      .prepare("UPDATE documents SET title = ?, body = ?, folder_id = ?, updated_at = ?, version = ? WHERE id = ?")
      .run(title, body, nextFolderId, timestamp, version, id);
    const change = insertChange(database.db, id, title, "updated", version, timestamp);
    return { value: getDocument(database.db, id) as DocumentRecord, change };
  });
}

export function deleteDocument(database: KnowledgeDatabase, id: string, expectedVersion: number, expectedHash?: string): void {
  if (database.vault) {
    const current = getDocument(database.db, id);
    if (!current) throw new MissingDocumentError();
    if (current.version !== expectedVersion || (expectedHash && current.contentHash && expectedHash !== current.contentHash)) {
      throw new VersionConflictError(current.version, current.contentHash);
    }
    try {
      database.vault.deleteDocument(id, expectedVersion, expectedHash);
      rebuildVaultIndex(database);
      return;
    } catch (error) {
      if (error instanceof VaultVersionConflictError) throw new VersionConflictError(error.currentVersion, error.currentHash);
      throw error;
    }
  }
  transact(database, () => {
    const current = getDocument(database.db, id);
    if (!current) throw new MissingDocumentError();
    if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
    const timestamp = new Date().toISOString();
    database.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    const change = insertChange(database.db, id, current.title, "deleted", expectedVersion + 1, timestamp);
    return { value: undefined, change };
  });
}

export type ImportedDocument = { title: string; body: string; folderId?: string | null };

export function importDocuments(database: KnowledgeDatabase, documents: ImportedDocument[]): DocumentRecord[] {
  if (database.vault) {
    const result = database.vault.importDocuments(documents);
    rebuildVaultIndex(database);
    return result.map((document) => getDocument(database.db, document.id) ?? document);
  }
  return transact(database, () => {
    const result: DocumentRecord[] = [];
    const changes: ChangeRecord[] = [];
    for (const document of documents) {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      const folderId = document.folderId ?? null;
      if (folderId !== null) requireFolder(database.db, folderId);
      database.db
        .prepare("INSERT INTO documents (id, title, body, folder_id, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)")
        .run(id, document.title, document.body, folderId, timestamp, timestamp);
      changes.push(insertChange(database.db, id, document.title, "created", 1, timestamp));
      result.push(getDocument(database.db, id) as DocumentRecord);
    }
    return { value: result, change: changes };
  });
}

export function getBacklinks(db: DatabaseSync, id: string): DocumentSummary[] {
  const target = getDocument(db, id);
  if (!target) throw new MissingDocumentError();
  const title = normalizeTitle(target.title);
  return (db.prepare("SELECT * FROM documents WHERE id <> ? ORDER BY updated_at DESC").all(id) as SqlRow[])
    .filter((row) => extractWikilinkTargets(String(row.body ?? "")).includes(title))
    .map((row) => mapSummary({ ...row, excerpt: excerptFromMarkdown(String(row.body ?? "")) }));
}

export function exportDocuments(db: DatabaseSync): DocumentRecord[] {
  return (db.prepare("SELECT * FROM documents ORDER BY title COLLATE NOCASE ASC").all() as SqlRow[]).map(mapDocument);
}
