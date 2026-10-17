import { existsSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { FileVault } from "./vault.js";
import type { DatabaseOptions, KnowledgeDatabase } from "./database/context.js";
import { migrate } from "./database/schema.js";
import { seedDatabase } from "./database/seed.js";
import { rebuildVaultIndex } from "./database/vault-index.js";

export type { KnowledgeDatabase } from "./database/context.js";
export { VersionConflictError, MissingFolderError, FolderNotEmptyError, FolderCycleError, DuplicateFolderNameError, MissingDocumentError } from "./database/errors.js";
export { reconcileVault, startVaultMonitor } from "./database/vault-index.js";
export { listFolders, getFolder, createFolder, updateFolder, deleteFolder } from "./database/folders.js";
export { listDocuments, getDocument, listTrashDocuments, listTrashedDocuments, trashDocument, restoreTrashedDocument, createDocument, updateDocument, deleteDocument, importDocuments, getBacklinks, exportDocuments } from "./database/documents.js";
export type { ImportedDocument } from "./database/documents.js";
export { getChangesAfter, getRecentChanges, getLatestChangeSequence } from "./database/changes.js";

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

function assertVaultPathWithinAllowedRoot(root: string, vaultDir: string): void {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, vaultDir);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("The selected vault path must remain inside its approved directory.");
  }
  let current = resolvedRoot;
  try {
    if (lstatSync(current).isSymbolicLink()) throw new Error("The approved vault directory cannot be a symbolic link.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("The selected vault path cannot pass through a symbolic link.");
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
  if (vaultDir) {
    if (options.vaultPathAllowRoot) assertVaultPathWithinAllowedRoot(options.vaultPathAllowRoot, vaultDir);
    else assertVaultPathWithinDataDir(resolvedDir, vaultDir);
  }
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
