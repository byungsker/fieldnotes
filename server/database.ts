import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { excerptFromMarkdown, extractWikilinkTargets, normalizeTitle } from "./markdown.js";
import type { ChangeRecord, DocumentRecord, DocumentSummary, FolderRecord } from "./types.js";
import { FileVault, VaultVersionConflictError } from "./vault.js";

type SqlRow = Record<string, string | number | null>;
type DatabaseOptions = { seedDemo?: boolean; vaultDir?: string };

export type KnowledgeDatabase = {
  db: DatabaseSync;
  dataDir: string;
  dbPath: string;
  vault?: FileVault;
  changes: EventEmitter;
  vaultIndexReady?: boolean;
  vaultIndexedSequence?: number;
};

export class VersionConflictError extends Error {
  readonly currentVersion: number;
  readonly currentHash?: string;

  constructor(currentVersion: number, currentHash?: string) {
    super("This item changed since you opened it. Load the latest version before saving again.");
    this.name = "VersionConflictError";
    this.currentVersion = currentVersion;
    this.currentHash = currentHash;
  }
}

export class MissingFolderError extends Error {
  constructor() {
    super("Folder not found.");
    this.name = "MissingFolderError";
  }
}

export class FolderNotEmptyError extends Error {
  constructor() {
    super("This folder contains notes or subfolders. Move or delete them before deleting the folder.");
    this.name = "FolderNotEmptyError";
  }
}

export class FolderCycleError extends Error {
  constructor() {
    super("A folder cannot be moved inside itself or one of its descendants.");
    this.name = "FolderCycleError";
  }
}

export class DuplicateFolderNameError extends Error {
  constructor() {
    super("A folder with this name already exists in that location.");
    this.name = "DuplicateFolderNameError";
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
    folderId: row.folder_id === null || row.folder_id === undefined ? null : String(row.folder_id),
    ...(row.file_path ? { filePath: String(row.file_path) } : {}),
    ...(row.content_hash ? { contentHash: String(row.content_hash) } : {}),
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
    folderId: row.folder_id === null || row.folder_id === undefined ? null : String(row.folder_id),
    ...(row.file_path ? { filePath: String(row.file_path) } : {}),
    ...(row.content_hash ? { contentHash: String(row.content_hash) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
    excerpt: String(row.excerpt ?? ""),
  };
}

function mapFolder(row: SqlRow): FolderRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    ...(row.file_path ? { filePath: String(row.file_path) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
    documentCount: Number(row.document_count ?? 0),
  };
}

function mapChange(row: SqlRow): ChangeRecord {
  const entityType = row.entity_type === "folder" ? "folder" : "document";
  const change = {
    seq: Number(row.seq),
    title: String(row.title),
    operation: String(row.operation) as ChangeRecord["operation"],
    version: Number(row.version),
    createdAt: String(row.created_at),
  };
  return entityType === "folder"
    ? { ...change, entityType, folderId: String(row.document_id) }
    : { ...change, entityType, documentId: String(row.document_id) };
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as SqlRow | undefined;
  let version = Number(row?.user_version ?? 0);
  if (version > 3) throw new Error(`Database schema ${version} is newer than this app supports.`);
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

function rebuildVaultIndex(database: KnowledgeDatabase): void {
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

function assertVaultPathWithinDataDir(dataDir: string, vaultDir: string): void {
  const relative = path.relative(dataDir, vaultDir);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("KB_VAULT_DIR must be a separate directory inside KB_DATA_DIR.");
  }
  let current = dataDir;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("KB_VAULT_DIR cannot pass through a symbolic link inside KB_DATA_DIR.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

export function openDatabase(dataDir: string, options: DatabaseOptions = {}): KnowledgeDatabase {
  const resolvedDir = path.resolve(dataDir);
  mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
  const configuredVault = options.vaultDir ?? process.env.KB_VAULT_DIR;
  const vaultDir = configuredVault ? path.resolve(configuredVault) : undefined;
  if (vaultDir) assertVaultPathWithinDataDir(resolvedDir, vaultDir);
  const dbPath = path.join(resolvedDir, vaultDir ? "vault-index.sqlite" : "knowledge.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  const database: KnowledgeDatabase = { db, dataDir: resolvedDir, dbPath, changes: new EventEmitter() };
  if (vaultDir) {
    if (!FileVault.hasState(vaultDir)) {
      const legacyPath = path.join(resolvedDir, "knowledge.sqlite");
      if (legacyPath !== dbPath && existsSync(legacyPath)) {
        const legacy = new DatabaseSync(legacyPath, { readOnly: true });
        try {
          const count = Number((legacy.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number }).count);
          if (count > 0) {
            db.close();
            throw new Error("KB_VAULT_DIR is set but the vault has no Fieldnotes manifest while the legacy SQLite library contains notes. Run the offline vault migration first.");
          }
        } finally {
          legacy.close();
        }
      }
    }
    database.vault = new FileVault(vaultDir);
    database.vaultIndexReady = false;
    database.vaultIndexedSequence = 0;
    const result = database.vault.reconcile();
    rebuildVaultIndex(database);
    if (result.changes.length && database.vaultIndexReady) {
      // Startup reconciliation is reflected in the index and is replayable from the
      // durable manifest. There are no SSE clients yet, so no initial broadcast is needed.
    }
  } else {
    seedDatabase(database, options.seedDemo ?? process.env.KB_SEED_DEMO_DATA !== "false");
  }
  return database;
}

export function closeDatabase(database: KnowledgeDatabase): void {
  database.db.close();
}

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

function requireFolder(db: DatabaseSync, id: string): FolderRecord {
  const folder = getFolder(db, id);
  if (!folder) throw new MissingFolderError();
  return folder;
}

function hasSiblingName(db: DatabaseSync, parentId: string | null, name: string, exceptId?: string): boolean {
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

export function createDocument(
  database: KnowledgeDatabase,
  title: string,
  body: string,
  folderId: string | null = null,
): DocumentRecord {
  if (database.vault) {
    const result = database.vault.createDocument(title, body, folderId);
    rebuildVaultIndex(database);
    return getDocument(database.db, result.document.id) ?? result.document;
  }
  const id = randomUUID();
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
