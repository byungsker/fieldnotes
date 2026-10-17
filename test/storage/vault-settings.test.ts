import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createApp } from "../../server/api.js";
import { closeDatabase, createDocument, openDatabase } from "../../server/storage/database.js";
import { resolveSavedVaultSelection, VaultSettingsService } from "../../server/storage/vault-settings.js";

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "fieldnotes-vault-settings-test-"));
after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

type ApiBody = {
  settings?: { currentPath: string | null; selectedPath: string | null; configuredPath: string | null; restartRequired: boolean };
  listing?: { directories: Array<{ name: string }> };
  verified?: boolean;
  state?: string;
  path?: string;
  error?: string;
};

async function json(baseUrl: string, pathname: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(10_000) });
  return { response, body: response.status === 204 ? {} : await response.json() as ApiBody };
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

test("vault settings browse Documents safely and persist a verified next-restart selection", async () => {
  const root = path.join(temporaryRoot, "api");
  const dataDir = path.join(root, "data");
  const documentsRoot = path.join(root, "Documents");
  const target = path.join(documentsRoot, "Fieldnotes vault");
  const unmanaged = path.join(documentsRoot, "Existing files");
  const symlinkTarget = path.join(documentsRoot, "Linked folder");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(documentsRoot, { recursive: true, mode: 0o700 });
  mkdirSync(target, { mode: 0o700 });
  mkdirSync(unmanaged, { mode: 0o700 });
  writeFileSync(path.join(unmanaged, "keep.txt"), "synthetic unmanaged file");
  mkdirSync(path.join(documentsRoot, ".hidden"), { mode: 0o700 });
  symlinkSync(target, symlinkTarget, "dir");

  const database = openDatabase(dataDir, { seedDemo: false });
  const settings = new VaultSettingsService(dataDir, null, documentsRoot, null);
  const app = createApp(database, undefined, { vaultSettings: { documentsRoot, configuredVaultPath: null } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let restartedDatabase: ReturnType<typeof openDatabase> | undefined;
  try {
    assert.throws(() => settings.verify(""), /Choose a folder inside the server Mac's Documents directory/u);
    assert.throws(() => settings.saveSelection(""), /Choose a folder inside the server Mac's Documents directory/u);
    const initial = await json(baseUrl, "/api/vault/settings");
    assert.equal(initial.response.status, 200);
    assert.ok(initial.body.settings);
    assert.equal(initial.body.settings.currentPath, null);
    assert.equal(initial.body.settings.selectedPath, null);

    const listing = await json(baseUrl, "/api/vault/settings/directories");
    assert.equal(listing.response.status, 200);
    assert.ok(listing.body.listing);
    assert.deepEqual(listing.body.listing.directories.map((entry) => entry.name), ["Existing files", "Fieldnotes vault"]);

    const traversal = await json(baseUrl, "/api/vault/settings/directories?relativePath=..%2F..%2Ftmp");
    assert.equal(traversal.response.status, 400);
    const linkedFolder = await json(baseUrl, "/api/vault/settings/verify", postJson({ relativePath: "Linked folder" }));
    assert.equal(linkedFolder.response.status, 400);
    const unmanagedFolder = await json(baseUrl, "/api/vault/settings/verify", postJson({ relativePath: "Existing files" }));
    assert.equal(unmanagedFolder.response.status, 400);

    const verified = await json(baseUrl, "/api/vault/settings/verify", postJson({ relativePath: "Fieldnotes vault" }));
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.verified, true);
    assert.equal(verified.body.state, "empty");
    assert.equal(verified.body.path, target);
    assert.equal(existsSync(path.join(target, ".fieldnotes", "state.json")), false);

    const selected = await json(baseUrl, "/api/vault/settings/selection", postJson({ relativePath: "Fieldnotes vault" }));
    assert.equal(selected.response.status, 200);
    assert.ok(selected.body.settings);
    assert.equal(selected.body.settings.currentPath, null);
    assert.equal(selected.body.settings.selectedPath, target);
    assert.equal(selected.body.settings.restartRequired, true);
    assert.equal(lstatSync(settings.settingsPath).mode & 0o777, 0o600);
    assert.deepEqual(resolveSavedVaultSelection(dataDir, documentsRoot), { absolutePath: target, relativePath: "Fieldnotes vault" });

    restartedDatabase = openDatabase(dataDir, {
      seedDemo: false,
      vaultDir: target,
      vaultPathAllowRoot: documentsRoot,
    });
    assert.equal(restartedDatabase.vault?.rootDir, target);
    assert.equal(existsSync(path.join(target, ".fieldnotes", "state.json")), true);
    closeDatabase(restartedDatabase);
    restartedDatabase = undefined;

    const cleared = await json(baseUrl, "/api/vault/settings/selection", { method: "DELETE" });
    assert.equal(cleared.response.status, 200);
    assert.ok(cleared.body.settings);
    assert.equal(cleared.body.settings.selectedPath, null);
    assert.equal(cleared.body.settings.restartRequired, false);
    assert.equal(existsSync(settings.settingsPath), false);
  } finally {
    if (restartedDatabase) closeDatabase(restartedDatabase);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(database);
  }
});

test("vault settings do not point a non-empty SQLite library at an empty folder", async () => {
  const root = path.join(temporaryRoot, "sqlite-with-notes");
  const dataDir = path.join(root, "data");
  const documentsRoot = path.join(root, "Documents");
  const target = path.join(documentsRoot, "Empty target");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(documentsRoot, { recursive: true, mode: 0o700 });
  mkdirSync(target, { mode: 0o700 });
  const database = openDatabase(dataDir, { seedDemo: false });
  createDocument(database, "Synthetic SQLite note", "Only used to test safe mode switching.");
  const app = createApp(database, undefined, { vaultSettings: { documentsRoot, configuredVaultPath: null } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const pathName of ["/api/vault/settings/verify", "/api/vault/settings/selection"]) {
      const response = await json(`http://127.0.0.1:${address.port}`, pathName, postJson({ relativePath: "Empty target" }));
      assert.equal(response.response.status, 409);
      assert.equal(response.body.error, "vault_migration_required");
    }
    assert.equal(existsSync(path.join(dataDir, ".fieldnotes-vault-selection.json")), false);
    assert.equal(existsSync(path.join(target, ".fieldnotes")), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(database);
  }
});
