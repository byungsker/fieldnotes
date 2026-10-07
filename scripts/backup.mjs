#!/usr/bin/env node
import { mkdirSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = path.resolve(process.env.KB_DATA_DIR ?? "./data");
const source = path.join(dataDir, process.env.KB_VAULT_DIR ? "vault-index.sqlite" : "knowledge.sqlite");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = path.resolve(process.argv[2] ?? path.join(dataDir, "..", "backups", `fieldnotes-${timestamp}.sqlite`));

function quotedPath(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function checkDatabase(database, label) {
  const result = database.prepare("PRAGMA quick_check").get();
  if (result?.quick_check !== "ok") throw new Error(`${label} failed SQLite quick_check.`);
}

if (!existsSync(source)) throw new Error(`No database found at ${source}. Start Fieldnotes once before backing it up.`);
if (source === destination) throw new Error("Backup destination must differ from the live database file.");
if (existsSync(destination)) throw new Error(`Refusing to overwrite existing backup: ${destination}`);

mkdirSync(path.dirname(destination), { recursive: true });
const database = new DatabaseSync(source);
try {
  checkDatabase(database, "Live database");
  // VACUUM INTO reads a consistent SQLite snapshot and includes committed WAL data.
  database.exec(`VACUUM INTO ${quotedPath(destination)}`);
  chmodSync(destination, 0o600);
} finally {
  database.close();
}

const backup = new DatabaseSync(destination, { readOnly: true });
try {
  checkDatabase(backup, "Backup");
} finally {
  backup.close();
}
console.log(`Created and verified SQLite backup: ${destination}`);
