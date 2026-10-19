import type { KnowledgeDatabase } from "./context.js";
import { publishSafely } from "./changes.js";
import type { VaultDocumentReadResult } from "../vault/types.js";

export function rebuildVaultIndex(database: KnowledgeDatabase): void {
  if (!database.vault) return;
  const snapshot = database.vault.snapshot();
  const previousSequence = database.vaultIndexedSequence ?? 0;
  const shouldPublish = Boolean(database.vaultIndexReady);
  const { db } = database;
  db.exec("BEGIN IMMEDIATE");
  try {
    const folders = [...snapshot.folders].sort((left, right) => (left.filePath?.split("/").length ?? 0) - (right.filePath?.split("/").length ?? 0));
    db.exec("DELETE FROM documents;");
    const removeFolder = db.prepare("DELETE FROM folders WHERE id = ?");
    for (const folder of [...folders].reverse()) removeFolder.run(folder.id);
    db.exec("DELETE FROM changes;");
    const insertFolder = db.prepare("INSERT INTO folders (id, name, parent_id, created_at, updated_at, version, file_path) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const folder of folders) insertFolder.run(folder.id, folder.name, folder.parentId, folder.createdAt, folder.updatedAt, folder.version, folder.filePath ?? "");
    const insertDocument = db.prepare("INSERT INTO documents (id, title, body, created_at, updated_at, version, folder_id, file_path, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const document of snapshot.documents) {
      insertDocument.run(document.id, document.title, document.body, document.createdAt, document.updatedAt, document.version, document.folderId, document.filePath ?? "", document.contentHash ?? "");
    }
    const insertChange = db.prepare("INSERT INTO changes (seq, document_id, title, operation, version, created_at, entity_type) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const change of snapshot.changes) {
      insertChange.run(change.seq, change.entityType === "folder" ? change.folderId ?? null : change.documentId ?? null, change.title, change.operation, change.version, change.createdAt, change.entityType);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    database.vaultIndexReady = false;
    throw error;
  }
  database.vaultIndexReady = true;
  database.vaultIndexedSequence = snapshot.sequence;
  if (shouldPublish) {
    for (const change of snapshot.changes) {
      if (change.seq > previousSequence) publishSafely(database.changes, change);
    }
  }
}

export function reconcileVault(database: KnowledgeDatabase): { changed: boolean; changes: number; sequence: number } {
  if (!database.vault) return { changed: false, changes: 0, sequence: 0 };
  const result = database.vault.reconcile();
  if (result.changed || result.changes.length > 0 || !database.vaultIndexReady || database.vaultIndexedSequence !== database.vault.sequence) {
    rebuildVaultIndex(database);
  }
  return { changed: result.changed, changes: result.changes.length, sequence: database.vault.sequence };
}

export function applyVaultDocumentRead(database: KnowledgeDatabase, result: VaultDocumentReadResult): void {
  if (!database.vault) return;
  if (result.fullReconcile || !database.vaultIndexReady) {
    rebuildVaultIndex(database);
    return;
  }
  if (!result.changes.length) return;

  const { db } = database;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const change of result.changes) {
      if (change.entityType !== "document" || !change.documentId) continue;
      if (result.document?.id === change.documentId) {
        const document = result.document;
        db.prepare(`
          INSERT INTO documents (id, title, body, created_at, updated_at, version, folder_id, file_path, content_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body,
            created_at = excluded.created_at, updated_at = excluded.updated_at,
            version = excluded.version, folder_id = excluded.folder_id,
            file_path = excluded.file_path, content_hash = excluded.content_hash
        `).run(document.id, document.title, document.body, document.createdAt, document.updatedAt, document.version, document.folderId, document.filePath ?? "", document.contentHash ?? "");
      } else {
        db.prepare("DELETE FROM documents WHERE id = ?").run(change.documentId);
      }
      db.prepare(`
        INSERT INTO changes (seq, document_id, entity_type, title, operation, version, created_at)
        VALUES (?, ?, 'document', ?, ?, ?, ?)
      `).run(change.seq, change.documentId, change.title, change.operation, change.version, change.createdAt);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    database.vaultIndexReady = false;
    throw error;
  }
  database.vaultIndexedSequence = database.vault.sequence;
  for (const change of result.changes) publishSafely(database.changes, change);
}
