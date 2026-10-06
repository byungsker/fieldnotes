import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { excerptFromMarkdown, extractWikilinkTargets, normalizeTitle } from "./markdown.js";
import type { ChangeRecord, DocumentRecord, DocumentSummary } from "./types.js";

type SqlRow = Record<string, string | number | null>;
type DatabaseOptions = { seedDemo?: boolean };

export type KnowledgeDatabase = {
  db: DatabaseSync;
  dataDir: string;
  changes: EventEmitter;
};

export class VersionConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super("This note changed since you opened it. Load the latest version before saving again.");
    this.name = "VersionConflictError";
    this.currentVersion = currentVersion;
  }
}

export class MissingDocumentError extends Error {
  constructor() {
    super("Note not found.");
    this.name = "MissingDocumentError";
  }
}

function mapDocument(row: SqlRow): DocumentRecord {
  const body = String(row.body ?? "");
  return {
    id: String(row.id),
    title: String(row.title),
    body,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
    excerpt: excerptFromMarkdown(body),
  };
}

function mapSummary(row: SqlRow): DocumentSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
    excerpt: String(row.excerpt ?? ""),
  };
}

function mapChange(row: SqlRow): ChangeRecord {
  return {
    seq: Number(row.seq),
    documentId: String(row.document_id),
    title: String(row.title),
    operation: String(row.operation) as ChangeRecord["operation"],
    version: Number(row.version),
    createdAt: String(row.created_at),
  };
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as SqlRow | undefined;
  const version = Number(row?.user_version ?? 0);
  if (version > 1) throw new Error(`Database schema ${version} is newer than this app supports.`);
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
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function publishSafely(changes: EventEmitter, change: ChangeRecord): void {
  try {
    changes.emit("change", change);
  } catch (error) {
    console.error("A live-change listener failed after the database commit:", error);
  }
}

function insertChange(
  db: DatabaseSync,
  documentId: string,
  title: string,
  operation: ChangeRecord["operation"],
  version: number,
  createdAt: string,
): ChangeRecord {
  const result = db
    .prepare("INSERT INTO changes (document_id, title, operation, version, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(documentId, title, operation, version, createdAt);
  return { seq: Number(result.lastInsertRowid), documentId, title, operation, version, createdAt };
}

function transact<T>(
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

function seedDatabase(database: KnowledgeDatabase, seedDemo: boolean): void {
  const seeded = database.db.prepare("SELECT value FROM app_meta WHERE key = 'initial_seed'").get();
  if (seeded) return;

  if (!seedDemo) {
    database.db.prepare("INSERT INTO app_meta (key, value) VALUES ('initial_seed', 'skipped')").run();
    return;
  }

  const samples = [
    {
      title: "Welcome to Fieldnotes",
      body: "# A quiet place for your ideas\n\nThis is a small demo notebook. Write in Markdown, connect thoughts with `[[wikilinks]]`, and let every saved note stay on this Mac.\n\n## A few ways to begin\n\n- Capture a thought before it slips away\n- Link a note with `[[Reading list]]`\n- Search across titles and full text\n\n> Your real vault is not imported. These notes are examples you can edit or delete.",
    },
    {
      title: "Reading list",
      body: "# Reading list\n\nA running shelf for things worth returning to.\n\n## Next up\n\n- Write down one idea from the next book or article\n- Add a link from a related note with `[[Welcome to Fieldnotes]]`\n\nKeep this list light enough to use.",
    },
    {
      title: "Small experiments",
      body: "# Small experiments\n\nA place to record little questions and what happens when you test them.\n\n### This week\n\nTry leaving one useful sentence at the end of a work session. Future-you gets a gentler starting point.",
    },
  ];

  const changes: ChangeRecord[] = [];
  database.db.exec("BEGIN IMMEDIATE");
  try {
    for (const sample of samples) {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      database.db
        .prepare("INSERT INTO documents (id, title, body, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)")
        .run(id, sample.title, sample.body, timestamp, timestamp);
      changes.push(insertChange(database.db, id, sample.title, "created", 1, timestamp));
    }
    database.db.prepare("INSERT INTO app_meta (key, value) VALUES ('initial_seed', 'demo')").run();
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
  for (const change of changes) publishSafely(database.changes, change);
}

export function openDatabase(dataDir: string, options: DatabaseOptions = {}): KnowledgeDatabase {
  const resolvedDir = path.resolve(dataDir);
  mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(resolvedDir, "knowledge.sqlite"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  const database: KnowledgeDatabase = { db, dataDir: resolvedDir, changes: new EventEmitter() };
  seedDatabase(database, options.seedDemo ?? process.env.KB_SEED_DEMO_DATA !== "false");
  return database;
}

export function closeDatabase(database: KnowledgeDatabase): void {
  database.db.close();
}

export function listDocuments(db: DatabaseSync, query = ""): DocumentSummary[] {
  const value = query.trim();
  const rows = value
    ? (db
        .prepare(
          `SELECT id, title, created_at, updated_at, version, body AS excerpt_source
           FROM documents
           WHERE instr(lower(title), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0
           ORDER BY updated_at DESC, title COLLATE NOCASE ASC`,
        )
        .all(value, value) as SqlRow[])
    : (db
        .prepare(
          "SELECT id, title, created_at, updated_at, version, body AS excerpt_source FROM documents ORDER BY updated_at DESC, title COLLATE NOCASE ASC",
        )
        .all() as SqlRow[]);
  return rows.map((row) =>
    mapSummary({ ...row, excerpt: excerptFromMarkdown(String(row.excerpt_source ?? "")) }),
  );
}

export function getDocument(db: DatabaseSync, id: string): DocumentRecord | undefined {
  const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as SqlRow | undefined;
  return row ? mapDocument(row) : undefined;
}

export function createDocument(
  database: KnowledgeDatabase,
  title: string,
  body: string,
): DocumentRecord {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  return transact(database, () => {
    database.db
      .prepare("INSERT INTO documents (id, title, body, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)")
      .run(id, title, body, timestamp, timestamp);
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
): DocumentRecord {
  return transact(database, () => {
    const current = getDocument(database.db, id);
    if (!current) throw new MissingDocumentError();
    if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
    const timestamp = new Date().toISOString();
    const version = current.version + 1;
    database.db
      .prepare("UPDATE documents SET title = ?, body = ?, updated_at = ?, version = ? WHERE id = ?")
      .run(title, body, timestamp, version, id);
    const change = insertChange(database.db, id, title, "updated", version, timestamp);
    return { value: getDocument(database.db, id) as DocumentRecord, change };
  });
}

export function deleteDocument(database: KnowledgeDatabase, id: string, expectedVersion: number): void {
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

export type ImportedDocument = { title: string; body: string };

export function importDocuments(database: KnowledgeDatabase, documents: ImportedDocument[]): DocumentRecord[] {
  return transact(database, () => {
    const result: DocumentRecord[] = [];
    const changes: ChangeRecord[] = [];
    for (const document of documents) {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      database.db
        .prepare("INSERT INTO documents (id, title, body, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)")
        .run(id, document.title, document.body, timestamp, timestamp);
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

export function exportDocuments(db: DatabaseSync): DocumentRecord[] {
  return (db.prepare("SELECT * FROM documents ORDER BY title COLLATE NOCASE ASC").all() as SqlRow[]).map(mapDocument);
}
