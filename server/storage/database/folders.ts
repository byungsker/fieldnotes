import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FolderRecord } from "../types.js";
import type { KnowledgeDatabase, SqlRow } from "./context.js";
import { DuplicateFolderNameError, FolderCycleError, FolderNotEmptyError, MissingFolderError, VersionConflictError } from "./errors.js";
import { insertChange, transact } from "./changes.js";
import { mapFolder } from "./records.js";
import { rebuildVaultIndex } from "./vault-index.js";

export function listFolders(db: DatabaseSync): FolderRecord[] {
  const rows = db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id) AS document_count
    FROM folders f
    ORDER BY f.name COLLATE NOCASE ASC, f.id ASC
  `).all() as SqlRow[];
  return rows.map(mapFolder);
}

export function getFolder(db: DatabaseSync, id: string): FolderRecord | undefined {
  const row = db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id) AS document_count
    FROM folders f WHERE f.id = ?
  `).get(id) as SqlRow | undefined;
  return row ? mapFolder(row) : undefined;
}

export function requireFolder(db: DatabaseSync, id: string): FolderRecord {
  const folder = getFolder(db, id);
  if (!folder) throw new MissingFolderError();
  return folder;
}

export function hasSiblingName(db: DatabaseSync, parentId: string | null, name: string, exceptId?: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS found FROM folders
    WHERE COALESCE(parent_id, '') = COALESCE(?, '')
      AND name = ? COLLATE NOCASE
      AND (? IS NULL OR id <> ?)
    LIMIT 1
  `).get(parentId, name, exceptId ?? null, exceptId ?? null) as SqlRow | undefined;
  return Boolean(row);
}

export function createFolder(database: KnowledgeDatabase, name: string, parentId: string | null): FolderRecord {
  if (database.vault) {
    const result = database.vault.createFolder(name, parentId);
    rebuildVaultIndex(database);
    return getFolder(database.db, result.folder.id) ?? result.folder;
  }
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  return transact(database, () => {
    if (parentId !== null) requireFolder(database.db, parentId);
    if (hasSiblingName(database.db, parentId, name)) throw new DuplicateFolderNameError();
    database.db
      .prepare("INSERT INTO folders (id, name, parent_id, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)")
      .run(id, name, parentId, timestamp, timestamp);
    const change = insertChange(database.db, id, name, "created", 1, timestamp, "folder");
    return { value: getFolder(database.db, id) as FolderRecord, change };
  });
}

export function updateFolder(
  database: KnowledgeDatabase,
  id: string,
  expectedVersion: number,
  changes: { name?: string; parentId?: string | null },
): FolderRecord {
  if (database.vault) {
    const result = database.vault.updateFolder(id, expectedVersion, changes);
    rebuildVaultIndex(database);
    return getFolder(database.db, id) ?? result.folder;
  }
  return transact(database, () => {
    const current = requireFolder(database.db, id);
    if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
    const name = changes.name ?? current.name;
    const parentId = changes.parentId === undefined ? current.parentId : changes.parentId;
    if (parentId !== null) {
      requireFolder(database.db, parentId);
      const cycle = database.db.prepare(`
        WITH RECURSIVE ancestors(id, parent_id) AS (
          SELECT id, parent_id FROM folders WHERE id = ?
          UNION ALL
          SELECT f.id, f.parent_id FROM folders f JOIN ancestors a ON f.id = a.parent_id
        )
        SELECT 1 AS cycle FROM ancestors WHERE id = ? LIMIT 1
      `).get(parentId, id);
      if (cycle) throw new FolderCycleError();
    }
    if (hasSiblingName(database.db, parentId, name, id)) throw new DuplicateFolderNameError();
    const timestamp = new Date().toISOString();
    const version = current.version + 1;
    database.db
      .prepare("UPDATE folders SET name = ?, parent_id = ?, updated_at = ?, version = ? WHERE id = ?")
      .run(name, parentId, timestamp, version, id);
    const change = insertChange(database.db, id, name, "updated", version, timestamp, "folder");
    return { value: getFolder(database.db, id) as FolderRecord, change };
  });
}

export function deleteFolder(database: KnowledgeDatabase, id: string, expectedVersion: number): void {
  if (database.vault) {
    database.vault.deleteFolder(id, expectedVersion);
    rebuildVaultIndex(database);
    return;
  }
  transact(database, () => {
    const current = requireFolder(database.db, id);
    if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
    const contents = database.db.prepare(`
      SELECT 1 AS found FROM documents WHERE folder_id = ?
      UNION ALL SELECT 1 AS found FROM folders WHERE parent_id = ? LIMIT 1
    `).get(id, id);
    if (contents) throw new FolderNotEmptyError();
    const timestamp = new Date().toISOString();
    database.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
    const change = insertChange(database.db, id, current.name, "deleted", current.version + 1, timestamp, "folder");
    return { value: undefined, change };
  });
}
