import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
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

function runCli(...arguments_: string[]) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/kb.mjs", ...arguments_], {
      cwd: projectDirectory,
      env: { ...process.env, KB_BASE_URL: baseUrl },
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
