import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { createApp } from "../server/api.js";
import { closeDatabase, createDocument, createFolder, openDatabase } from "../server/database.js";
import { FileVault } from "../server/vault.js";

const projectDirectory = path.resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "fieldnotes-vault-test-"));
after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

async function json(baseUrl: string, pathname: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(10_000) });
  const body = response.status === 204 ? undefined : await response.json();
  return { response, body };
}

function postJson(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function runCli(baseUrl: string, ...arguments_: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/kb.mjs", ...arguments_], {
      cwd: projectDirectory,
      env: { ...process.env, KB_BASE_URL: baseUrl, KB_AUTH_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function listen(database: ReturnType<typeof openDatabase>) {
  const app = createApp(database);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not bind to an ephemeral loopback port.");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("filesystem mode keeps Markdown authoritative across API, CLI, external edits, conflicts, and index rebuild", async () => {
  const dataDir = path.join(temporaryRoot, "api-data");
  const vaultDir = path.join(dataDir, "vaults", "default");
  let database = openDatabase(dataDir, { seedDemo: false, vaultDir });
  let live = await listen(database);
  try {
    const health = await json(live.baseUrl, "/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.storageMode, "filesystem");
    assert.equal(health.body.schemaVersion, 3);

    const folderResult = await json(live.baseUrl, "/api/folders", postJson("POST", { name: "Research" }));
    assert.equal(folderResult.response.status, 201);
    const folder = folderResult.body.folder;
    const reservedFolder = await json(live.baseUrl, "/api/folders", postJson("POST", { name: ".FIELDNOTES" }));
    assert.equal(reservedFolder.response.status, 400);
    const noOpFolderUpdate = await json(live.baseUrl, `/api/folders/${folder.id}`, postJson("PUT", {
      expectedVersion: folder.version,
      name: folder.name,
      parentId: folder.parentId,
    }));
    assert.equal(noOpFolderUpdate.response.status, 200);
    assert.equal(noOpFolderUpdate.body.folder.version, folder.version);
    const created = await json(live.baseUrl, "/api/documents", postJson("POST", {
      title: "Research note",
      body: "Initial **Markdown** body.",
      folderId: folder.id,
    }));
    assert.equal(created.response.status, 201);
    const document = created.body.document;
    assert.equal(document.filePath, "Research/Research note.md");
    assert.equal(readFileSync(path.join(vaultDir, document.filePath), "utf8"), "Initial **Markdown** body.");
    assert.match(document.contentHash, /^[0-9a-f]{64}$/);
    const duplicateTitle = await json(live.baseUrl, "/api/documents", postJson("POST", {
      title: document.title,
      body: "A second note with the same display title.",
      folderId: folder.id,
    }));
    assert.equal(duplicateTitle.response.status, 201);
    assert.notEqual(duplicateTitle.body.document.filePath, document.filePath);
    const duplicateSaved = await json(live.baseUrl, `/api/documents/${duplicateTitle.body.document.id}`, postJson("PUT", {
      expectedVersion: 1,
      expectedHash: duplicateTitle.body.document.contentHash,
      title: duplicateTitle.body.document.title,
      body: "Updated duplicate title without path collision.",
    }));
    assert.equal(duplicateSaved.response.status, 200);
    assert.equal(duplicateSaved.body.document.filePath, duplicateTitle.body.document.filePath);
    const duplicateDelete = await json(live.baseUrl, `/api/documents/${duplicateTitle.body.document.id}`, postJson("DELETE", {
      expectedVersion: duplicateSaved.body.document.version,
      expectedHash: duplicateSaved.body.document.contentHash,
    }));
    assert.equal(duplicateDelete.response.status, 204);

    const cliList = await runCli(live.baseUrl, "list", "--query", "Research note");
    assert.equal(cliList.status, 0, cliList.stderr);
    assert.match(cliList.stdout, new RegExp(document.id));
    assert.match(cliList.stdout, /Research\/Research note\.md/);
    const cliRead = await runCli(live.baseUrl, "read", document.id);
    assert.equal(cliRead.status, 0, cliRead.stderr);
    assert.match(cliRead.stdout, /Initial \*\*Markdown\*\* body\./);
    assert.match(cliRead.stdout, new RegExp(document.contentHash));

    const cursor = (await json(live.baseUrl, "/api/changes?after=0")).body.highWatermark;
    const cliUpdate = await runCli(live.baseUrl, "update", document.id, "--version", "1", "--body", "Changed by CLI.");
    assert.equal(cliUpdate.status, 0, cliUpdate.stderr);
    const afterCli = await json(live.baseUrl, `/api/documents/${document.id}`);
    assert.equal(afterCli.body.document.body, "Changed by CLI.");
    assert.equal(readFileSync(path.join(vaultDir, document.filePath), "utf8"), "Changed by CLI.");
    const changesAfterCli = await json(live.baseUrl, `/api/changes?after=${cursor}`);
    assert.ok(changesAfterCli.body.changes.some((change: { documentId?: string; operation: string }) => change.documentId === document.id && change.operation === "updated"));

    const stale = afterCli.body.document;
    writeFileSync(path.join(vaultDir, stale.filePath), "Edited directly in Finder.\n", "utf8");
    const reconciled = await json(live.baseUrl, `/api/documents/${document.id}`);
    assert.equal(reconciled.body.document.body, "Edited directly in Finder.\n");
    assert.equal(reconciled.body.document.version, stale.version + 1);
    const staleSave = await json(live.baseUrl, `/api/documents/${document.id}`, postJson("PUT", {
      expectedVersion: stale.version,
      expectedHash: stale.contentHash,
      title: stale.title,
      body: "This stale save must lose.",
    }));
    assert.equal(staleSave.response.status, 409);
    assert.equal(staleSave.body.currentVersion, reconciled.body.document.version);
    const staleDelete = await json(live.baseUrl, `/api/documents/${document.id}`, postJson("DELETE", {
      expectedVersion: stale.version,
      expectedHash: stale.contentHash,
    }));
    assert.equal(staleDelete.response.status, 409);
    const safeBody = await json(live.baseUrl, `/api/documents/${document.id}`);
    assert.equal(safeBody.body.document.body, "Edited directly in Finder.\n");

    const externalPath = path.join(vaultDir, "External draft.md");
    writeFileSync(externalPath, "Imported from a generic Markdown file.\n", "utf8");
    const externalList = await json(live.baseUrl, "/api/documents?q=External%20draft");
    const external = externalList.body.documents[0];
    assert.equal(external.title, "External draft");
    const externalId = external.id;
    const renamedPath = path.join(vaultDir, "Renamed externally.md");
    renameSync(externalPath, renamedPath);
    const renamed = await json(live.baseUrl, `/api/documents/${externalId}`);
    assert.equal(renamed.body.document.id, externalId);
    assert.equal(renamed.body.document.title, "Renamed externally");
    assert.equal(renamed.body.document.filePath, "Renamed externally.md");
    unlinkSync(renamedPath);
    const deleted = await json(live.baseUrl, `/api/documents/${externalId}`);
    assert.equal(deleted.response.status, 404);

    const traversal = await json(live.baseUrl, "/api/documents", postJson("POST", { title: "../escape", body: "No path write." }));
    assert.equal(traversal.response.status, 201);
    assert.equal(traversal.body.document.title, "../escape");
    assert.ok(!traversal.body.document.filePath.includes("../"));
    assert.ok(existsSync(path.join(vaultDir, traversal.body.document.filePath)));
    assert.equal(existsSync(path.join(dataDir, "escape.md")), false);
    await json(live.baseUrl, `/api/documents/${traversal.body.document.id}`, postJson("DELETE", {
      expectedVersion: traversal.body.document.version,
      expectedHash: traversal.body.document.contentHash,
    }));

    const movable = await json(live.baseUrl, "/api/documents", postJson("POST", { title: "Move me", body: "Safe." }));
    const moved = await json(live.baseUrl, `/api/documents/${movable.body.document.id}`, postJson("PUT", {
      expectedVersion: 1,
      expectedHash: movable.body.document.contentHash,
      title: "Move me",
      body: "Safe.",
      folderId: folder.id,
    }));
    assert.equal(moved.response.status, 200);
    assert.equal(moved.body.document.filePath, "Research/Move me.md");
    assert.equal(existsSync(path.join(vaultDir, "Move me.md")), false);
    const moveBack = await json(live.baseUrl, `/api/documents/${movable.body.document.id}`, postJson("PUT", {
      expectedVersion: moved.body.document.version,
      expectedHash: moved.body.document.contentHash,
      title: "Move me",
      body: "Safe.",
      folderId: null,
    }));
    assert.equal(moveBack.body.document.filePath, "Move me.md");

    const replayCursor = (await json(live.baseUrl, "/api/changes?after=0")).body.highWatermark;
    const raceVersion = moveBack.body.document;
    const raced = await Promise.all([
      json(live.baseUrl, `/api/documents/${raceVersion.id}`, postJson("PUT", { expectedVersion: raceVersion.version, expectedHash: raceVersion.contentHash, title: raceVersion.title, body: "Winner A" })),
      json(live.baseUrl, `/api/documents/${raceVersion.id}`, postJson("PUT", { expectedVersion: raceVersion.version, expectedHash: raceVersion.contentHash, title: raceVersion.title, body: "Winner B" })),
    ]);
    assert.deepEqual(raced.map((result) => result.response.status).sort(), [200, 409]);

    await live.close();
    closeDatabase(database);
    const indexBackup = path.join(dataDir, "private-backups", "verified-index.sqlite");
    execFileSync(process.execPath, ["scripts/backup.mjs", indexBackup], {
      cwd: projectDirectory,
      env: { ...process.env, KB_DATA_DIR: dataDir, KB_VAULT_DIR: vaultDir },
      stdio: "pipe",
    });
    const backupDb = new DatabaseSync(indexBackup, { readOnly: true });
    try {
      assert.equal(Number(backupDb.prepare("SELECT COUNT(*) AS count FROM documents").get()?.count), 2);
      assert.equal(Number(backupDb.prepare("PRAGMA user_version").get()?.user_version), 3);
    } finally {
      backupDb.close();
    }
    database = openDatabase(dataDir, { seedDemo: false, vaultDir });
    live = await listen(database);
    const status = await runCli(live.baseUrl, "vault", "status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /"mode": "filesystem"/);
    const rebuilt = await json(live.baseUrl, `/api/documents/${raceVersion.id}`);
    assert.match(rebuilt.body.document.body, /^Winner [AB]$/);
    assert.ok(rebuilt.body.document.version > raceVersion.version);
    const replay = await json(live.baseUrl, `/api/changes?after=${replayCursor}`);
    assert.ok(replay.body.changes.some((change: { documentId?: string; operation: string }) => change.documentId === raceVersion.id && change.operation === "updated"));

    await live.close();
    closeDatabase(database);
    for (const suffix of ["", "-wal", "-shm"]) {
      const indexPath = path.join(dataDir, `vault-index.sqlite${suffix}`);
      if (existsSync(indexPath)) unlinkSync(indexPath);
    }
    database = openDatabase(dataDir, { seedDemo: false, vaultDir });
    live = await listen(database);
    const rebuiltWithoutIndex = await json(live.baseUrl, `/api/documents/${raceVersion.id}`);
    assert.equal(rebuiltWithoutIndex.body.document.body, rebuilt.body.document.body);
    assert.equal(rebuiltWithoutIndex.body.document.id, raceVersion.id);
  } finally {
    await live.close();
    closeDatabase(database);
  }
});

test("migration CLI verifies a backup then preserves every document, folder, and history row", () => {
  const dataDir = path.join(temporaryRoot, "migration-data");
  const vaultDir = path.join(dataDir, "vaults", "default");
  const backupPath = path.join(dataDir, "private-backups", "verified.sqlite");
  const manifestPath = path.join(dataDir, "private-backups", "migration-manifest.json");
  const source = openDatabase(dataDir, { seedDemo: false });
  const parent = createFolder(source, "Research & notes", null);
  const child = createFolder(source, "Nested: Folder", parent.id);
  const longTitle = "📝".repeat(100);
  const first = createDocument(source, "../A: research", "# Exact body\r\n\r\nA path-safe Markdown note.", child.id);
  const duplicate = createDocument(source, "../A: research", "Second exact body.", child.id);
  const long = createDocument(source, longTitle, "Long Unicode filename.", null);
  const original = [first, duplicate, long];
  closeDatabase(source);

  execFileSync(process.execPath, ["scripts/backup.mjs", backupPath], {
    cwd: projectDirectory,
    env: { ...process.env, KB_DATA_DIR: dataDir, KB_VAULT_DIR: "" },
    stdio: "pipe",
  });
  const output = execFileSync(process.execPath, ["--import", "tsx/esm", "scripts/vault-migrate.ts", "--backup", backupPath, "--vault-dir", vaultDir, "--manifest", manifestPath, "--server-stopped"], {
    cwd: projectDirectory,
    env: { ...process.env, KB_DATA_DIR: dataDir, KB_VAULT_DIR: "" },
    encoding: "utf8",
  });
  assert.match(output, /Verified Markdown vault: 3 documents, 2 folders/);
  assert.ok(existsSync(manifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { documents: Array<{ id: string; filePath?: string; relativePath: string }> };
  assert.equal(manifest.documents.length, original.length);

  const migrated = new FileVault(vaultDir).snapshot();
  assert.deepEqual(new Map(migrated.documents.map((document) => [document.id, document.body])), new Map(original.map((document) => [document.id, document.body])));
  assert.ok(migrated.documents.every((document) => !document.filePath?.includes("..")));
  assert.ok(migrated.documents.some((document) => document.filePath?.includes("%2F")));
  assert.ok(new Set(migrated.documents.map((document) => document.filePath)).size === original.length);
  assert.equal(migrated.folders.find((folder) => folder.id === child.id)?.parentId, parent.id);
  assert.equal(migrated.folders.find((folder) => folder.id === child.id)?.name, child.name);
  assert.equal(migrated.documents.find((document) => document.id === first.id)?.body, first.body);
  assert.equal(migrated.documents.find((document) => document.id === duplicate.id)?.body, duplicate.body);
  assert.ok(migrated.documents.find((document) => document.id === long.id)?.filePath);

  const opened = openDatabase(dataDir, { seedDemo: false, vaultDir });
  try {
    assert.equal(Number(opened.db.prepare("PRAGMA user_version").get()?.user_version), 3);
    assert.equal(Number(opened.db.prepare("SELECT COUNT(*) AS count FROM documents").get()?.count), original.length);
    const indexedFolder = opened.db.prepare("SELECT name, file_path FROM folders WHERE id = ?").get(child.id) as { name: string; file_path: string };
    assert.equal(indexedFolder.name, child.name);
    assert.ok(indexedFolder.file_path.includes("%3A"));
    assert.equal(Number(opened.db.prepare("SELECT COUNT(*) AS count FROM changes").get()?.count), migrated.changes.length);
  } finally {
    closeDatabase(opened);
  }

  const vaultBackup = path.join(dataDir, "private-backups", "vault-backup");
  const restoredVault = path.join(dataDir, "vaults", "restored");
  const vaultEnv = { ...process.env, KB_DATA_DIR: dataDir, KB_VAULT_DIR: vaultDir };
  const backupOutput = execFileSync(process.execPath, ["--import", "tsx/esm", "scripts/vault-files.ts", "backup", "--server-stopped", "--destination", vaultBackup], {
    cwd: projectDirectory,
    env: vaultEnv,
    encoding: "utf8",
  });
  assert.match(backupOutput, /Verified vault backup: 3 documents, 2 folders/);
  const restoreOutput = execFileSync(process.execPath, ["--import", "tsx/esm", "scripts/vault-files.ts", "restore", "--backup-dir", vaultBackup, "--vault-dir", restoredVault, "--server-stopped"], {
    cwd: projectDirectory,
    env: vaultEnv,
    encoding: "utf8",
  });
  assert.match(restoreOutput, /Restored and verified vault: 3 documents, 2 folders/);
  assert.deepEqual(
    new Map(new FileVault(restoredVault).snapshot().documents.map((document) => [document.id, document.body])),
    new Map(new FileVault(vaultDir).snapshot().documents.map((document) => [document.id, document.body])),
  );
});

test("vault refuses symlinks and case-variant reserved metadata names", () => {
  const vaultDir = path.join(temporaryRoot, "safe-vault");
  const outside = path.join(temporaryRoot, "outside.md");
  mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  writeFileSync(outside, "must not be read or modified", "utf8");
  const vault = new FileVault(vaultDir);
  const symlinkPath = path.join(vaultDir, "outside.md");
  try {
    // Symlink creation is supported by the current Mac test environment.
    symlinkSync(outside, symlinkPath);
    assert.throws(() => vault.reconcile(), /Symbolic link/);
    assert.equal(readFileSync(outside, "utf8"), "must not be read or modified");
  } finally {
    if (existsSync(symlinkPath)) unlinkSync(symlinkPath);
  }
  const invalidMarkdown = path.join(vaultDir, "invalid-encoding.md");
  writeFileSync(invalidMarkdown, Buffer.from([0xff, 0xfe]));
  assert.throws(() => vault.reconcile(), /not valid UTF-8/);
  unlinkSync(invalidMarkdown);
  assert.equal(vault.reconcile().changed, false);

  const caseVariantVault = path.join(temporaryRoot, "case-variant-vault");
  mkdirSync(caseVariantVault, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(caseVariantVault, ".FIELDNOTES"), "preserve", "utf8");
  assert.throws(() => new FileVault(caseVariantVault), /reserved/);
  assert.equal(readFileSync(path.join(caseVariantVault, ".FIELDNOTES"), "utf8"), "preserve");
});

test("filesystem mode rejects a configured vault path that crosses a symlink below the data directory", () => {
  const dataDir = path.join(temporaryRoot, "symlinked-data-root");
  const outside = path.join(temporaryRoot, "symlinked-data-outside");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(outside, { recursive: true, mode: 0o700 });
  symlinkSync(outside, path.join(dataDir, "vaults"), "dir");

  assert.throws(
    () => openDatabase(dataDir, { seedDemo: false, vaultDir: path.join(dataDir, "vaults", "default") }),
    /symbolic link inside KB_DATA_DIR/,
  );
  assert.equal(existsSync(path.join(outside, "default")), false);
  assert.equal(existsSync(path.join(dataDir, "vault-index.sqlite")), false);
});
