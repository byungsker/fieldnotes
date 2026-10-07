#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, chmodSync, statSync, lstatSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FileVault, createVaultFromLegacy, type LegacyDocument, type LegacyFolder } from "../server/vault.js";
import type { ChangeRecord } from "../server/types.js";

type LegacySnapshot = { documents: LegacyDocument[]; folders: LegacyFolder[]; changes: ChangeRecord[]; schemaVersion: number };

function parseArgs(values: string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "server-stopped") {
      result[key] = true;
      continue;
    }
    const value = values[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    result[key] = value;
    i += 1;
  }
  return result;
}

function requirePath(args: Record<string, string | true>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required.`);
  return path.resolve(value);
}

function readSnapshot(file: string): LegacySnapshot {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const quickCheck = db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
    if (quickCheck.quick_check !== "ok") throw new Error(`SQLite quick_check failed for ${path.basename(file)}.`);
    const schemaVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
    if (schemaVersion > 3 || schemaVersion < 1) throw new Error(`Unsupported SQLite schema ${schemaVersion} in ${path.basename(file)}.`);
    const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
    const documentColumns = columns("documents");
    const folderColumns = columns("folders");
    const changeColumns = columns("changes");
    const folderId = documentColumns.has("folder_id") ? "folder_id" : "NULL AS folder_id";
    const documents = (db.prepare(`SELECT id, title, body, ${folderId}, created_at, updated_at, version FROM documents ORDER BY id`).all() as Array<Record<string, string | number | null>>).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      body: String(row.body),
      folderId: row.folder_id === null ? null : String(row.folder_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      version: Number(row.version),
    }));
    const folders: LegacyFolder[] = folderColumns.has("id")
      ? (db.prepare("SELECT id, name, parent_id, created_at, updated_at, version FROM folders ORDER BY id").all() as Array<Record<string, string | number | null>>).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        parentId: row.parent_id === null ? null : String(row.parent_id),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        version: Number(row.version),
      }))
      : [];
    const entityType = changeColumns.has("entity_type") ? "entity_type" : "'document' AS entity_type";
    const changes = (db.prepare(`SELECT seq, document_id, title, operation, version, created_at, ${entityType} FROM changes ORDER BY seq`).all() as Array<Record<string, string | number | null>>).map((row) => {
      const type: ChangeRecord["entityType"] = String(row.entity_type) === "folder" ? "folder" : "document";
      const common: Omit<ChangeRecord, "documentId" | "folderId"> = {
        seq: Number(row.seq),
        entityType: type,
        title: String(row.title),
        operation: String(row.operation) as ChangeRecord["operation"],
        version: Number(row.version),
        createdAt: String(row.created_at),
      };
      const id = String(row.document_id);
      return type === "folder" ? { ...common, entityType: type, folderId: id } : { ...common, entityType: type, documentId: id };
    });
    return { documents, folders, changes, schemaVersion };
  } finally {
    db.close();
  }
}

function compareSnapshots(left: LegacySnapshot, right: LegacySnapshot): void {
  assert.deepStrictEqual(left.documents, right.documents, "The live SQLite database and requested backup differ in document rows.");
  assert.deepStrictEqual(left.folders, right.folders, "The live SQLite database and requested backup differ in folder rows.");
  assert.deepStrictEqual(left.changes, right.changes, "The live SQLite database and requested backup differ in change history.");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function assertNoSymlinkBelow(root: string, target: string, description: string): void {
  if (!isInside(root, target)) throw new Error(`${description} must remain inside KB_DATA_DIR.`);
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`${description} cannot pass through a symbolic link inside KB_DATA_DIR.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args["server-stopped"] !== true) throw new Error("Migration requires --server-stopped after a clean Fieldnotes shutdown.");
  const dataDir = path.resolve(process.env.KB_DATA_DIR ?? "./data");
  const livePath = path.join(dataDir, "knowledge.sqlite");
  const backupPath = requirePath(args, "backup");
  const vaultPath = requirePath(args, "vault-dir");
  const privateBackupDir = path.join(dataDir, "private-backups");
  const manifestPath = typeof args.manifest === "string"
    ? path.resolve(args.manifest)
    : path.join(privateBackupDir, `fieldnotes-migration-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const lockPath = path.join(dataDir, "server.lock");
  if (existsSync(lockPath)) throw new Error(`Found ${lockPath}. Stop Fieldnotes and confirm the lock is gone before migration.`);
  if (!existsSync(livePath)) throw new Error(`Live SQLite database not found at ${livePath}.`);
  if (!existsSync(backupPath)) throw new Error(`SQLite backup not found at ${backupPath}.`);
  if (path.resolve(livePath) === backupPath) throw new Error("--backup must point to a separate verified SQLite backup.");
  if (!isInside(dataDir, vaultPath)) throw new Error("--vault-dir must remain inside KB_DATA_DIR so code and private data stay separate from the repository.");
  if (existsSync(vaultPath)) throw new Error("Migration target already exists. Choose a new app-owned vault directory; existing files are never overwritten.");
  if (!isInside(privateBackupDir, manifestPath)) throw new Error("The migration manifest must be stored under KB_DATA_DIR/private-backups.");
  assertNoSymlinkBelow(dataDir, vaultPath, "--vault-dir");
  assertNoSymlinkBelow(dataDir, privateBackupDir, "Private backup directory");
  assertNoSymlinkBelow(dataDir, manifestPath, "Migration manifest");
  if (existsSync(manifestPath)) throw new Error("Refusing to overwrite the private migration manifest.");
  if (process.env.KB_VAULT_DIR) throw new Error("Unset KB_VAULT_DIR before migrating from the legacy SQLite library.");

  mkdirSync(privateBackupDir, { recursive: true, mode: 0o700 });
  chmodSync(privateBackupDir, 0o700);
  if ((statSync(privateBackupDir).mode & 0o077) !== 0) throw new Error("The private backup directory must not be readable by group or other users.");
  const active = readSnapshot(livePath);
  const backup = readSnapshot(backupPath);
  compareSnapshots(active, backup);
  const result = createVaultFromLegacy(vaultPath, backup.documents, backup.folders, backup.changes, manifestPath);
  const migrated = new FileVault(vaultPath).snapshot();
  assert.equal(migrated.documents.length, backup.documents.length, "Migrated document count differs from the verified backup.");
  assert.equal(migrated.folders.length, backup.folders.length, "Migrated folder count differs from the verified backup.");
  assert.deepStrictEqual(migrated.changes, backup.changes, "Migrated change history differs from the verified backup.");
  const migratedFolders = new Map(migrated.folders.map((folder) => [folder.id, folder]));
  for (const expected of backup.folders) {
    const actual = migratedFolders.get(expected.id);
    assert.ok(actual, "A source folder ID is missing from the Markdown vault.");
    assert.equal(actual.name, expected.name);
    assert.equal(actual.parentId, expected.parentId);
    assert.equal(actual.createdAt, expected.createdAt);
    assert.equal(actual.updatedAt, expected.updatedAt);
    assert.equal(actual.version, expected.version);
  }
  const migratedById = new Map(migrated.documents.map((document) => [document.id, document]));
  for (const expected of backup.documents) {
    const actual = migratedById.get(expected.id);
    assert.ok(actual, "A source document ID is missing from the Markdown vault.");
    assert.equal(actual.title, expected.title);
    assert.equal(actual.body, expected.body);
    assert.equal(actual.folderId, expected.folderId);
    assert.equal(actual.createdAt, expected.createdAt);
    assert.equal(actual.updatedAt, expected.updatedAt);
    assert.equal(actual.version, expected.version);
    assert.equal(actual.contentHash, createHash("sha256").update(expected.body, "utf8").digest("hex"));
  }
  console.log(`Verified Markdown vault: ${result.documentCount} documents, ${result.folderCount} folders, ${result.sequence} change events.`);
  console.log(`Vault path: ${vaultPath}`);
  console.log(`Private manifest: ${manifestPath}`);
  console.log("The original knowledge.sqlite was read-only and was not modified. Set KB_VAULT_DIR only after reviewing this verification.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
