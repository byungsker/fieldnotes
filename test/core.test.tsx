import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createApp } from "../server/api.js";
import { closeDatabase, createDocument, exportDocuments, openDatabase } from "../server/database.js";
import { MarkdownBody } from "../src/MarkdownBody";

const projectDirectory = path.resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "fieldnotes-test-"));
const dataDirectory = path.join(temporaryRoot, "main-data");
const database = openDatabase(dataDirectory, { seedDemo: false });
const app = createApp(database);
let server: ReturnType<typeof app.listen>;
const baseUrl = await new Promise<string>((resolve, reject) => {
  server = app.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("Could not read the test server address."));
      return;
    }
    assert.equal(address.address, "127.0.0.1");
    resolve(`http://127.0.0.1:${address.port}`);
  });
  server.once("error", reject);
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase(database);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

async function json(pathname: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(5_000) });
  const body = response.status === 204 ? undefined : await response.json();
  return { response, body };
}

function postJson(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function runCliWithEnvironment(environment: Record<string, string>, ...arguments_: string[]) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/kb.mjs", ...arguments_], {
      cwd: projectDirectory,
      env: { ...process.env, KB_BASE_URL: baseUrl, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

function runCli(...arguments_: string[]) {
  return runCliWithEnvironment({}, ...arguments_);
}

async function nextChange(after: number, lastEventId?: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`${baseUrl}/api/events?after=${after}`, {
      signal: controller.signal,
      headers: lastEventId === undefined ? {} : { "Last-Event-ID": String(lastEventId) },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let data = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      data += decoder.decode(chunk.value, { stream: true });
      const match = data.match(/event: change\ndata: (\{[^\n]+\})\n\n/);
      if (match) {
        await reader.cancel();
        return JSON.parse(match[1]);
      }
    }
    throw new Error("SSE stream ended before a change event arrived.");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

test("human API and agent CLI create, read, search, update, and delete the same note", async () => {
  const created = await json("/api/documents", postJson("POST", {
    title: "Shared note",
    body: "A human saved this with the word orchid.\n\nSee [[Reading list]].",
  }));
  assert.equal(created.response.status, 201);
  const note = created.body.document;

  const read = await runCli("read", note.id);
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /A human saved this with the word orchid/);

  const search = await runCli("search", "orchid");
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, new RegExp(note.id));

  const update = await runCli("update", note.id, "--version", "1", "--title", "Agent updated note", "--body", "The CLI updated this note.");
  assert.equal(update.status, 0, update.stderr);
  const latest = await json(`/api/documents/${note.id}`);
  assert.equal(latest.body.document.title, "Agent updated note");
  assert.equal(latest.body.document.body, "The CLI updated this note.");
  assert.equal(latest.body.document.version, 2);

  const staleCliWrite = await runCli("update", note.id, "--version", "1", "--body", "Must not overwrite.");
  assert.equal(staleCliWrite.status, 1);
  const afterConflict = await json(`/api/documents/${note.id}`);
  assert.equal(afterConflict.body.document.body, "The CLI updated this note.");

  const deleteResult = await runCli("delete", note.id, "--version", "2");
  assert.equal(deleteResult.status, 0, deleteResult.stderr);
  const missing = await json(`/api/documents/${note.id}`);
  assert.equal(missing.response.status, 404);
});

test("stale concurrent updates and stale deletes are rejected atomically", async () => {
  const created = await json("/api/documents", postJson("POST", { title: "Race", body: "start" }));
  const id = created.body.document.id;
  const updates = await Promise.all([
    json(`/api/documents/${id}`, postJson("PUT", { expectedVersion: 1, title: "First", body: "first" })),
    json(`/api/documents/${id}`, postJson("PUT", { expectedVersion: 1, title: "Second", body: "second" })),
  ]);
  assert.deepEqual(updates.map((result) => result.response.status).sort(), [200, 409]);
  const winner = await json(`/api/documents/${id}`);
  assert.equal(winner.body.document.version, 2);
  assert.ok(["First", "Second"].includes(winner.body.document.title));

  const staleDelete = await json(`/api/documents/${id}`, postJson("DELETE", { expectedVersion: 1 }));
  assert.equal(staleDelete.response.status, 409);
  const currentDelete = await json(`/api/documents/${id}`, postJson("DELETE", { expectedVersion: 2 }));
  assert.equal(currentDelete.response.status, 204);
  assert.equal((await json(`/api/documents/${id}`)).response.status, 404);
});

test("changes survive a disconnect and replay from the last SSE event id", async () => {
  const beforeChanges = await json("/api/changes?after=0");
  let cursor = beforeChanges.body.highWatermark;
  const first = await json("/api/documents", postJson("POST", { title: "Reconnect one", body: "First committed write." }));
  const firstResult = await json(`/api/changes?after=${cursor}`);
  const firstChange = firstResult.body.changes[0];
  assert.equal(firstChange.documentId, first.body.document.id);
  cursor = firstChange.seq;

  const second = await json("/api/documents", postJson("POST", { title: "Reconnect two", body: "Second committed write." }));
  const replayed = await nextChange(0, cursor);
  assert.equal(replayed.documentId, second.body.document.id);
  assert.ok(replayed.seq > cursor);

  const third = await json(`/api/documents/${second.body.document.id}`, postJson("PUT", {
    expectedVersion: 1,
    title: "Reconnect two",
    body: "Edited while a client is away.",
  }));
  const reconciliation = await json(`/api/changes?after=${replayed.seq}`);
  assert.equal(reconciliation.body.changes[0].version, third.body.document.version);
  assert.equal(reconciliation.body.highWatermark, reconciliation.body.changes[0].seq);
});

test("generic Markdown import/export preserves content and path-like inputs cannot reach files", async () => {
  const markdown = "---\ntags: [demo]\n---\n\n# Imported\n\nRaw HTML stays inert: <script>window.compromised = true</script>\n\n[bad](javascript:alert(1))";
  const imported = await json("/api/import", postJson("POST", {
    documents: [{ title: "Imported markdown", body: markdown }, { title: "Another file", body: "Body two." }],
  }));
  assert.equal(imported.response.status, 201);
  assert.equal(imported.body.documents.length, 2);
  assert.equal(imported.body.documents[0].body, markdown);

  const exported = await json("/api/export");
  assert.equal(exported.body.format, "fieldnotes-export");
  assert.ok(exported.body.documents.some((document) => document.body === markdown));

  const invalid = await json("/api/import", postJson("POST", { documents: [{ title: "Valid", body: "ok" }, { title: "  ", body: "bad" }] }));
  assert.equal(invalid.response.status, 400);
  assert.equal((await json("/api/documents?q=Valid")).body.documents.length, 0);

  const pathLikeId = await json("/api/documents/not-a-uuid");
  assert.equal(pathLikeId.response.status, 400);
  const traversal = await fetch(`${baseUrl}/api/documents/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
  assert.notEqual(traversal.status, 200);

  const rendered = renderToStaticMarkup(React.createElement(MarkdownBody, {
    markdown: `${markdown}\n\n[[Reading list]]`,
    documents: [{ id: "reading-list-id", title: "Reading list", createdAt: "", updatedAt: "", version: 1, excerpt: "" }],
    onOpenDocument: () => undefined,
  }));
  assert.doesNotMatch(rendered, /<script(?:\s|>)/i);
  assert.doesNotMatch(rendered, /href="javascript:/i);
  assert.match(rendered, /href="#reading-list-id"/);
  assert.match(rendered, /class="wiki-link"/);
});

test("cross-origin writes are rejected", async () => {
  const result = await fetch(`${baseUrl}/api/documents`, {
    ...postJson("POST", { title: "Nope", body: "" }),
    headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" },
  });
  assert.equal(result.status, 403);
});

test("SQLite backup uses VACUUM INTO and restore validates plus preserves the previous database", () => {
  const sourceDirectory = path.join(temporaryRoot, "backup-source");
  const targetDirectory = path.join(temporaryRoot, "restore-target");
  const backupPath = path.join(temporaryRoot, "fieldnotes-safe-backup.sqlite");

  const source = openDatabase(sourceDirectory, { seedDemo: false });
  createDocument(source, "Portable note", "Committed before backup.");
  closeDatabase(source);

  execFileSync(process.execPath, ["scripts/backup.mjs", backupPath], {
    cwd: projectDirectory,
    env: { ...process.env, KB_DATA_DIR: sourceDirectory },
  });
  assert.ok(existsSync(backupPath));

  const target = openDatabase(targetDirectory, { seedDemo: false });
  createDocument(target, "Prior target", "Will be protected before restore.");
  closeDatabase(target);

  execFileSync(process.execPath, ["scripts/restore.mjs", backupPath, "--server-stopped"], {
    cwd: projectDirectory,
    env: { ...process.env, KB_DATA_DIR: targetDirectory },
  });
  const restored = openDatabase(targetDirectory, { seedDemo: false });
  const notes = exportDocuments(restored.db);
  closeDatabase(restored);
  assert.deepEqual(notes.map((note) => note.title), ["Portable note"]);
  assert.equal(notes[0].body, "Committed before backup.");
  assert.equal(readdirSync(targetDirectory).some((filename) => filename.startsWith("pre-restore-")), true);
});

test("nested and empty folders support safe CRUD, document moves, search, and folder SSE replay", async () => {
  const initial = await json("/api/changes?after=0");
  let cursor = initial.body.highWatermark;
  const rootResult = await json("/api/folders", postJson("POST", { name: "Tree root test" }));
  assert.equal(rootResult.response.status, 201);
  const root = rootResult.body.folder;
  assert.equal(root.parentId, null);
  assert.equal(root.documentCount, 0);
  const createdChange = await nextChange(cursor);
  assert.equal(createdChange.entityType, "folder");
  assert.equal(createdChange.folderId, root.id);
  cursor = createdChange.seq;

  let leaf = root;
  const nestedFolders = [root];
  for (let depth = 0; depth < 48; depth += 1) {
    const result = await json("/api/folders", postJson("POST", {
      name: `Nested ${depth}`,
      parentId: leaf.id,
    }));
    assert.equal(result.response.status, 201);
    leaf = result.body.folder;
    nestedFolders.push(leaf);
  }
  const folders = (await json("/api/folders")).body.folders;
  assert.equal(folders.length, 49);
  assert.equal(folders.find((folder: { id: string }) => folder.id === leaf.id).documentCount, 0);

  const target = await json("/api/documents", postJson("POST", { title: "Folder link target", body: "Target body." }));
  const noteResult = await json("/api/documents", postJson("POST", {
    title: "Deep note",
    body: "Keep [[Folder link target]] when moving this note.",
    folderId: leaf.id,
  }));
  assert.equal(noteResult.response.status, 201);
  const note = noteResult.body.document;
  assert.equal(note.folderId, leaf.id);
  assert.equal((await json(`/api/documents?folderId=${leaf.id}`)).body.documents[0].id, note.id);
  assert.equal((await json(`/api/folders/${leaf.id}`)).body.folder.documentCount, 1);
  assert.equal((await json(`/api/backlinks/${target.body.document.id}`)).body.backlinks[0].id, note.id);

  const moved = await json(`/api/documents/${note.id}`, postJson("PUT", {
    expectedVersion: 1,
    title: note.title,
    body: note.body,
    folderId: root.id,
  }));
  assert.equal(moved.response.status, 200);
  assert.equal(moved.body.document.version, 2);
  assert.equal(moved.body.document.folderId, root.id);
  assert.equal(moved.body.document.body, note.body);
  assert.equal((await json(`/api/documents?folderId=${leaf.id}`)).body.documents.length, 0);
  assert.equal((await json(`/api/documents?folderId=${root.id}&q=deep`)).body.documents[0].id, note.id);

  const siblingDuplicate = await json("/api/folders", postJson("POST", {
    name: "nested 0",
    parentId: root.id,
  }));
  assert.equal(siblingDuplicate.response.status, 409);
  assert.equal(siblingDuplicate.body.error, "duplicate_folder");

  const cycleAttempt = await json(`/api/folders/${root.id}`, postJson("PUT", {
    expectedVersion: 1,
    parentId: leaf.id,
  }));
  assert.equal(cycleAttempt.response.status, 409);
  assert.equal(cycleAttempt.body.error, "folder_cycle");
  assert.equal((await json(`/api/folders/${root.id}`)).body.folder.parentId, null);

  const child = nestedFolders[1];
  const renamed = await json(`/api/folders/${child.id}`, postJson("PUT", {
    expectedVersion: 1,
    name: "Renamed nested",
  }));
  assert.equal(renamed.body.folder.version, 2);
  const staleRename = await json(`/api/folders/${child.id}`, postJson("PUT", {
    expectedVersion: 1,
    name: "Must not win",
  }));
  assert.equal(staleRename.response.status, 409);
  assert.equal((await json(`/api/folders/${child.id}`)).body.folder.name, "Renamed nested");

  const nonEmptyDelete = await json(`/api/folders/${root.id}`, postJson("DELETE", { expectedVersion: 1 }));
  assert.equal(nonEmptyDelete.response.status, 409);
  assert.equal(nonEmptyDelete.body.error, "folder_not_empty");
  const leafOccupant = await json("/api/documents", postJson("POST", {
    title: "Leaf occupant",
    body: "Do not disappear with the folder.",
    folderId: leaf.id,
  }));
  const occupiedLeafDelete = await json(`/api/folders/${leaf.id}`, postJson("DELETE", { expectedVersion: 1 }));
  assert.equal(occupiedLeafDelete.response.status, 409);
  assert.equal(occupiedLeafDelete.body.error, "folder_not_empty");
  assert.equal((await json(`/api/documents/${leafOccupant.body.document.id}`)).response.status, 200);

  const emptyFolder = await json("/api/folders", postJson("POST", { name: "Empty delete test" }));
  assert.equal((await json(`/api/folders/${emptyFolder.body.folder.id}`, postJson("DELETE", { expectedVersion: 1 }))).response.status, 204);
  const noPathWrite = await json("/api/folders", postJson("POST", { name: "../escape" }));
  assert.equal(noPathWrite.response.status, 400);

  const cliCreated = await runCli("folder", "create", "--name", "CLI folder test");
  assert.equal(cliCreated.status, 0, cliCreated.stderr);
  const cliFolderId = cliCreated.stdout.match(/Created folder ([0-9a-f-]+)/)?.[1];
  assert.ok(cliFolderId);
  const listed = await runCli("folder", "list");
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(cliFolderId));
  const cliRenamed = await runCli("folder", "rename", cliFolderId, "--version", "1", "--name", "CLI renamed");
  assert.equal(cliRenamed.status, 0, cliRenamed.stderr);
  const cliMoved = await runCli("folder", "move", cliFolderId, "--version", "2", "--parent", root.id);
  assert.equal(cliMoved.status, 0, cliMoved.stderr);
  const cliNoteResult = await json("/api/documents", postJson("POST", { title: "CLI folder note", body: "Preserve this body." }));
  const cliNote = cliNoteResult.body.document;
  const cliMoveNote = await runCli("move-document", cliNote.id, "--version", "1", "--folder", cliFolderId);
  assert.equal(cliMoveNote.status, 0, cliMoveNote.stderr);
  const cliMovedNote = (await json(`/api/documents/${cliNote.id}`)).body.document;
  assert.equal(cliMovedNote.folderId, cliFolderId);
  assert.equal(cliMovedNote.body, "Preserve this body.");
  assert.equal((await runCli("folder", "delete", cliFolderId, "--version", "3")).status, 1);
  assert.equal((await runCli("move-document", cliNote.id, "--version", "2", "--folder", "root")).status, 0);
  assert.equal((await runCli("folder", "delete", cliFolderId, "--version", "3")).status, 0);

  const replay = await nextChange(cursor);
  assert.equal(replay.entityType, "folder");
  assert.ok(replay.folderId);
  const exportResponse = await json("/api/export");
  assert.equal(exportResponse.body.schemaVersion, 2);
  assert.ok(Array.isArray(exportResponse.body.folders));
  assert.ok(exportResponse.body.documents.some((document: { id: string }) => document.id === note.id));
});

test("CLI forwards optional bearer tokens over HTTPS or loopback only", async () => {
  let authorization: string | undefined;
  const tokenServer = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ documents: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    tokenServer.once("error", reject);
    tokenServer.listen(0, "127.0.0.1", resolve);
  });
  const address = tokenServer.address();
  assert.ok(address && typeof address !== "string");
  try {
    const loopbackResult = await runCliWithEnvironment({
      KB_BASE_URL: `http://127.0.0.1:${address.port}`,
      KB_AUTH_TOKEN: "ephemeral-test-token",
    }, "list");
    assert.equal(loopbackResult.status, 0, loopbackResult.stderr);
    assert.equal(authorization, "Bearer ephemeral-test-token");

    const plaintextRemoteResult = await runCliWithEnvironment({
      KB_BASE_URL: "http://example.com",
      KB_AUTH_TOKEN: "ephemeral-test-token",
    }, "list");
    assert.equal(plaintextRemoteResult.status, 1);
    assert.match(plaintextRemoteResult.stderr, /only be sent to HTTPS origins or loopback/);
  } finally {
    await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
  }
});

test("schema v1 migrates forward without changing existing note IDs, Markdown, or change history", () => {
  const legacyDirectory = path.join(temporaryRoot, "legacy-v1");
  const legacyPath = path.join(legacyDirectory, "knowledge.sqlite");
  const legacyId = "11111111-1111-4111-8111-111111111111";
  const legacyBody = "# Existing note\n\nKeep [[Existing target]] and front matter.";
  mkdirSync(legacyDirectory, { recursive: true });
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
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
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = 1;
  `);
  legacy.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)").run(legacyId, "Existing note", legacyBody, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 7);
  legacy.prepare("INSERT INTO changes (document_id, title, operation, version, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(legacyId, "Existing note", "updated", 7, "2026-01-01T00:00:00.000Z");
  legacy.close();

  const upgraded = openDatabase(legacyDirectory, { seedDemo: false });
  try {
    assert.equal(Number(upgraded.db.prepare("PRAGMA user_version").get()?.user_version), 2);
    const existing = upgraded.db.prepare("SELECT id, title, body, version, folder_id FROM documents WHERE id = ?").get(legacyId) as Record<string, unknown>;
    assert.equal(existing.id, legacyId);
    assert.equal(existing.title, "Existing note");
    assert.equal(existing.body, legacyBody);
    assert.equal(existing.version, 7);
    assert.equal(existing.folder_id, null);
    const oldChange = upgraded.db.prepare("SELECT document_id, title, entity_type, version FROM changes WHERE seq = 1").get() as Record<string, unknown>;
    assert.equal(oldChange.document_id, legacyId);
    assert.equal(oldChange.title, "Existing note");
    assert.equal(oldChange.entity_type, "document");
    assert.equal(oldChange.version, 7);
  } finally {
    closeDatabase(upgraded);
  }
});
