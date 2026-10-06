#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const backup = path.resolve(process.argv[2] ?? "");
const acknowledgedStopped = process.argv.includes("--server-stopped");
const dataDir = path.resolve(process.env.KB_DATA_DIR ?? "./data");
const destination = path.join(dataDir, "knowledge.sqlite");

function quotedPath(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function checkDatabase(database, label) {
  const result = database.prepare("PRAGMA quick_check").get();
  if (result?.quick_check !== "ok") throw new Error(`${label} failed SQLite quick_check.`);
  const version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version > 1) throw new Error(`${label} schema ${version} is newer than this app supports.`);
}

function assertNoServerLock() {
  const lockPath = path.join(dataDir, "server.lock");
  if (!existsSync(lockPath)) return;
  let lock;
  try {
    lock = JSON.parse(awaitRead(lockPath));
  } catch (error) {
    throw new Error(`Cannot verify ${lockPath}. Inspect it and stop Fieldnotes before restoring.`, { cause: error });
  }
  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid < 1) throw new Error(`Invalid server lock at ${lockPath}; inspect it before restoring.`);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code !== "ESRCH") throw new Error(`Cannot verify whether process ${pid} is running.`, { cause: error });
      unlinkSync(lockPath);
      return;
    }
    throw new Error(`Fieldnotes process ${pid} is still running. Stop it before restoring.`);
  }
  unlinkSync(lockPath);
}

function awaitRead(file) {
  // Kept synchronous because this script is intentionally a single short maintenance step.
  return readFileSync(file, "utf8");
}

if (!backup || backup === path.resolve(".")) throw new Error("Usage: node scripts/restore.mjs BACKUP.sqlite --server-stopped");
if (!acknowledgedStopped) throw new Error("Restore requires --server-stopped after you stop the Fieldnotes server.");
if (!existsSync(backup)) throw new Error(`Backup file not found: ${backup}`);
if (backup === destination) throw new Error("Restore source must differ from the active data file.");

assertNoServerLock();
for (const suffix of ["-wal", "-shm"]) {
  const sidecar = `${destination}${suffix}`;
  if (existsSync(sidecar)) throw new Error(`Found ${sidecar}. Confirm Fieldnotes has exited cleanly before restoring.`);
}

const sourceDatabase = new DatabaseSync(backup, { readOnly: true });
try {
  checkDatabase(sourceDatabase, "Restore source");
} finally {
  sourceDatabase.close();
}

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
let safetyBackup;
if (existsSync(destination)) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  safetyBackup = path.join(dataDir, `pre-restore-${timestamp}.sqlite`);
  const current = new DatabaseSync(destination);
  try {
    checkDatabase(current, "Current database");
    current.exec(`VACUUM INTO ${quotedPath(safetyBackup)}`);
  } finally {
    current.close();
  }
}

const temporary = path.join(dataDir, `.restore-${randomUUID()}.sqlite`);
try {
  copyFileSync(backup, temporary);
  const restored = new DatabaseSync(temporary, { readOnly: true });
  try {
    checkDatabase(restored, "Staged restore");
  } finally {
    restored.close();
  }
  const fileDescriptor = openSync(temporary, "r");
  try { fsyncSync(fileDescriptor); } finally { closeSync(fileDescriptor); }
  renameSync(temporary, destination);
} catch (error) {
  if (existsSync(temporary)) unlinkSync(temporary);
  throw error;
}

console.log(`Restored and verified: ${destination}`);
if (safetyBackup) console.log(`Previous data preserved at: ${safetyBackup}`);
