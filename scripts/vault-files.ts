#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  constants,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { closeDatabase, openDatabase } from "../server/database.js";
import { FileVault, VaultStorageError } from "../server/vault.js";

function parseArgs(values: string[]): { command?: string; flags: Record<string, string | true> } {
  const [command, ...rest] = values;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "server-stopped") {
      flags[name] = true;
      continue;
    }
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}.`);
    flags[name] = value;
    i += 1;
  }
  return { command, flags };
}

function requireFlag(flags: Record<string, string | true>, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required.`);
  return path.resolve(value);
}

function assertStopped(dataDir: string, flags: Record<string, string | true>): void {
  if (flags["server-stopped"] !== true) throw new Error("Vault file operations require --server-stopped after a clean Fieldnotes shutdown.");
  const lock = path.join(dataDir, "server.lock");
  if (existsSync(lock)) throw new Error(`Found ${lock}. Stop Fieldnotes and confirm the lock is gone before continuing.`);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Some supported filesystems do not expose directory fsync.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new VaultStorageError("Vault backup root must be a real directory, not a symbolic link.", "vault_symlink", 409);
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  for (const name of readdirSync(source).sort((left, right) => left.localeCompare(right))) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const entry = lstatSync(from);
    if (entry.isSymbolicLink()) throw new VaultStorageError(`Symbolic links are not allowed in vault backups (${name}).`, "vault_symlink", 409);
    if (entry.isDirectory()) {
      await copyTree(from, to);
      fsyncDirectory(destination);
      continue;
    }
    if (!entry.isFile()) throw new VaultStorageError(`Unsupported special file in vault backup (${name}).`, "vault_entry_invalid", 409);
    let input: number | undefined;
    let output: number | undefined;
    try {
      input = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!fstatSync(input).isFile()) throw new VaultStorageError("Vault file changed type while being backed up.", "vault_entry_invalid", 409);
      output = openSync(to, "wx", 0o600);
      await pipeline(
        createReadStream(from, { fd: input, autoClose: false }),
        createWriteStream(to, { fd: output, autoClose: false }),
      );
      fsyncSync(output);
      closeSync(output);
      output = undefined;
      closeSync(input);
      input = undefined;
      fsyncDirectory(destination);
    } finally {
      if (input !== undefined) closeSync(input);
      if (output !== undefined) closeSync(output);
    }
  }
  chmodSync(destination, 0o700);
  fsyncDirectory(destination);
}

function verifyVaults(source: string, copy: string): { documentCount: number; folderCount: number; sequence: number } {
  const original = new FileVault(source).snapshot();
  const restored = new FileVault(copy);
  restored.reconcile();
  const snapshot = restored.snapshot();
  assert.deepStrictEqual(snapshot.documents, original.documents, "Vault document bytes or metadata changed during copy.");
  assert.deepStrictEqual(snapshot.folders, original.folders, "Vault folder metadata changed during copy.");
  assert.deepStrictEqual(snapshot.changes, original.changes, "Vault change history changed during copy.");
  return { documentCount: snapshot.documents.length, folderCount: snapshot.folders.length, sequence: snapshot.sequence };
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(process.env.KB_DATA_DIR ?? "./data");
  assertStopped(dataDir, flags);
  if (command === "backup") {
    const configured = process.env.KB_VAULT_DIR;
    if (!configured) throw new Error("KB_VAULT_DIR must point to the active Markdown vault before creating a vault backup.");
    const source = path.resolve(configured);
    assertNoSymlinkBelow(dataDir, source, "KB_VAULT_DIR");
    if (!FileVault.hasState(source)) throw new Error("No Fieldnotes vault manifest was found at KB_VAULT_DIR.");
    const backupDir = path.join(dataDir, "private-backups");
    assertNoSymlinkBelow(dataDir, backupDir, "Private backup directory");
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const destination = typeof flags.destination === "string"
      ? path.resolve(flags.destination)
      : path.join(backupDir, `fieldnotes-vault-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    if (isInside(dataDir, destination)) assertNoSymlinkBelow(dataDir, destination, "Backup destination");
    if (path.resolve(destination) === source || isInside(source, destination)) throw new Error("Vault backup destination must be outside the active vault.");
    if (existsSync(destination)) throw new Error("Vault backup destination already exists; refusing to overwrite it.");
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.staging-${randomUUID()}`);
    try {
      const index = openDatabase(dataDir, { seedDemo: false, vaultDir: source });
      closeDatabase(index);
      await copyTree(source, staging);
      const counts = verifyVaults(source, staging);
      if (existsSync(destination)) throw new Error("Vault backup destination appeared during the copy; no existing directory was changed.");
      renameSync(staging, destination);
      fsyncDirectory(path.dirname(destination));
      console.log(`Verified vault backup: ${counts.documentCount} documents, ${counts.folderCount} folders, ${counts.sequence} change events.`);
      console.log(`Backup path: ${destination}`);
      return;
    } catch (error) {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  if (command === "restore") {
    const backup = requireFlag(flags, "backup-dir");
    const destination = requireFlag(flags, "vault-dir");
    if (lstatSync(backup).isSymbolicLink()) throw new Error("Selected backup root cannot be a symbolic link.");
    if (!FileVault.hasState(backup)) throw new Error("The selected backup does not contain a Fieldnotes vault manifest.");
    if (!isInside(dataDir, destination)) throw new Error("--vault-dir must remain inside KB_DATA_DIR; restore creates a new app-owned vault path.");
    assertNoSymlinkBelow(dataDir, destination, "--vault-dir");
    if (existsSync(destination)) throw new Error("Restore target already exists. Existing vaults are never overwritten.");
    if (path.resolve(backup) === destination || isInside(backup, destination)) throw new Error("Restore target must be outside the selected backup directory.");
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.restore-${randomUUID()}`);
    try {
      await copyTree(backup, staging);
      const counts = verifyVaults(backup, staging);
      if (existsSync(destination)) throw new Error("Restore target appeared during the operation; no existing directory was changed.");
      renameSync(staging, destination);
      fsyncDirectory(path.dirname(destination));
      console.log(`Restored and verified vault: ${counts.documentCount} documents, ${counts.folderCount} folders, ${counts.sequence} change events.`);
      console.log(`Restore path: ${destination}`);
      console.log("Review the restored vault, then point KB_VAULT_DIR at this path. The previous vault and SQLite files were not changed.");
      return;
    } catch (error) {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  throw new Error("Usage: scripts/vault-files.ts backup --server-stopped [--destination PATH] | restore --backup-dir PATH --vault-dir PATH --server-stopped");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
