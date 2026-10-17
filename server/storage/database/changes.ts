import type { DatabaseSync } from "node:sqlite";
import type { EventEmitter } from "node:events";
import type { ChangeRecord } from "../types.js";
import type { KnowledgeDatabase, SqlRow } from "./context.js";
import { mapChange } from "./records.js";

export function publishSafely(changes: EventEmitter, change: ChangeRecord): void {
  try {
    changes.emit("change", change);
  } catch (error) {
    console.error("A live-change listener failed after the database commit:", error);
  }
}

export function insertChange(
  db: DatabaseSync,
  entityId: string,
  title: string,
  operation: ChangeRecord["operation"],
  version: number,
  createdAt: string,
  entityType: ChangeRecord["entityType"] = "document",
): ChangeRecord {
  const result = db
    .prepare("INSERT INTO changes (document_id, entity_type, title, operation, version, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(entityId, entityType, title, operation, version, createdAt);
  const common = { seq: Number(result.lastInsertRowid), entityType, title, operation, version, createdAt };
  return entityType === "folder"
    ? { ...common, folderId: entityId }
    : { ...common, documentId: entityId };
}

export function transact<T>(
  database: KnowledgeDatabase,
  action: () => { value: T; change: ChangeRecord | ChangeRecord[] },
): T {
  const { db, changes } = database;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    const batch = Array.isArray(result.change) ? result.change : [result.change];
    for (const change of batch) publishSafely(changes, change);
    return result.value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getChangesAfter(db: DatabaseSync, after: number, limit = 500): ChangeRecord[] {
  return (db
    .prepare("SELECT * FROM changes WHERE seq > ? ORDER BY seq ASC LIMIT ?")
    .all(after, limit) as SqlRow[]).map(mapChange);
}

export function getRecentChanges(db: DatabaseSync, limit = 16): ChangeRecord[] {
  const rows = db.prepare("SELECT * FROM changes ORDER BY seq DESC LIMIT ?").all(limit) as SqlRow[];
  return rows.map(mapChange).reverse();
}

export function getLatestChangeSequence(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes").get() as SqlRow;
  return Number(row.seq ?? 0);
}
