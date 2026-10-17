import type { DatabaseSync } from "node:sqlite";
import type { SqlRow } from "./context.js";

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as SqlRow | undefined;
  let version = Number(row?.user_version ?? 0);
  if (version > 4) throw new Error(`Database schema ${version} is newer than this app supports.`);
  if (version === 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
          body TEXT NOT NULL CHECK(length(body) <= 250000),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version >= 1)
        );
        CREATE INDEX documents_updated_at ON documents(updated_at DESC);
        CREATE TABLE changes (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id TEXT NOT NULL,
          title TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('created', 'updated', 'deleted')),
          version INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX changes_created_at ON changes(seq DESC);
        CREATE TABLE app_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      db.exec("COMMIT");
      version = 1;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (version === 0 || version === 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE folders (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
          parent_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version >= 1)
        );
        CREATE INDEX folders_parent_id ON folders(parent_id);
        CREATE UNIQUE INDEX folders_sibling_name
          ON folders(COALESCE(parent_id, ''), name COLLATE NOCASE);
        ALTER TABLE documents ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE RESTRICT;
        CREATE INDEX documents_folder_id ON documents(folder_id);
        ALTER TABLE changes ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'document'
          CHECK(entity_type IN ('document', 'folder'));
        PRAGMA user_version = 2;
      `);
      db.exec("COMMIT");
      version = 2;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (version === 2) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE documents ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE documents ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
        ALTER TABLE folders ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
        PRAGMA user_version = 3;
      `);
      db.exec("COMMIT");
      version = 3;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (version === 3) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE trash_documents (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
          body TEXT NOT NULL CHECK(length(body) <= 250000),
          folder_id TEXT,
          file_path TEXT NOT NULL DEFAULT '',
          content_hash TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          trashed_at TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version >= 1)
        );
        CREATE INDEX trash_documents_trashed_at ON trash_documents(trashed_at DESC);
        PRAGMA user_version = 4;
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
