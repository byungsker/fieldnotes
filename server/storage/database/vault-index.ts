import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { KnowledgeDatabase } from "./context.js";
import { publishSafely } from "./changes.js";

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

export function reconcileVault(database: KnowledgeDatabase): void {
  if (!database.vault) return;
  const result = database.vault.reconcile();
  if (result.changed || result.changes.length > 0 || !database.vaultIndexReady || database.vaultIndexedSequence !== database.vault.sequence) {
    rebuildVaultIndex(database);
  }
}

export function startVaultMonitor(database: KnowledgeDatabase): () => void {
  if (!database.vault) return () => {};
  let busy = false;
  let debounce: NodeJS.Timeout | undefined;
  const reconcile = () => {
    if (busy) return;
    busy = true;
    try {
      reconcileVault(database);
    } catch (error) {
      console.error("Vault reconciliation failed; files were left untouched:", error);
    } finally {
      busy = false;
    }
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(database.vault.rootDir, { recursive: true }, (_event, filename) => {
      const name = filename?.toString() ?? "";
      if (name === ".fieldnotes" || name.startsWith(`.fieldnotes${path.sep}`) || name.includes(".fieldnotes-tmp-")) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(reconcile, 100);
      debounce.unref();
    });
  } catch {
    // The periodic full scan remains the correctness path when recursive watching is unavailable.
  }
  const timer = setInterval(reconcile, 2_000);
  timer.unref();
  return () => {
    if (timer) clearInterval(timer);
    if (debounce) clearTimeout(debounce);
    watcher?.close();
  };
}
