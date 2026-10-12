import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../server/api.js";
import { closeDatabase, createDocument, listTrashedDocuments, openDatabase, trashDocument, restoreTrashedDocument } from "../server/database.js";
import { parseFrontmatter } from "../server/frontmatter.js";
import { TmdbMovieSearchAdapter } from "../server/movie-search.js";
import { ViewQueryLimitError } from "../server/view-query-limits.js";
import { parseVisualizationUiEvent, type MovieSearchResult } from "../shared/visualization.js";
import { parseFieldnotesViewConfig } from "../packages/markdown-live-editor/fieldnotes-view-config.js";

type ApiResponseBody = {
  notes?: Array<{ id: string; title: string; version: number; contentHash: string; frontmatter: Record<string, unknown> }>;
  trash?: Array<{ id: string; title: string; version: number; folderId: string | null; trashedAt: string; excerpt: string }>;
  note?: { id: string; title: string; version: number; path: string };
  results?: MovieSearchResult[];
  error?: string;
  sequence?: number;
};

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "fieldnotes-native-actions-"));
const database = openDatabase(path.join(temporaryRoot, "data"), { seedDemo: false });
const fixtureDirectory = path.join(process.cwd(), "test", "fixtures", "native-visualizations");
const source = "\uFEFF---\r\ntitle: 'Keep me: exactly'\r\nstatus: active # keep this comment\r\nprogress: 0.4\r\nnested:\r\n  label: preserve\r\n---\r\nBody line one.\r\n\r\nBody line two.\r\n";
const goal = createDocument(database, "Fixture goal", source);
const article = createDocument(database, "Fixture article", readFileSync(path.join(fixtureDirectory, "article-draft.md"), "utf8"));
const baby = createDocument(database, "Fixture milestone", readFileSync(path.join(fixtureDirectory, "baby-milestone.md"), "utf8"));
createDocument(database, "Fixture movie", readFileSync(path.join(fixtureDirectory, "movie-entry.md"), "utf8"));
const dashboards = ["goals-dashboard.md", "articles-dashboard.md", "babies-dashboard.md", "movies-dashboard.md"]
  .map((filename) => readFileSync(path.join(fixtureDirectory, filename), "utf8"));
const mockResults: MovieSearchResult[] = [{
  id: 123,
  title: "Arrival",
  originalTitle: "Arrival",
  releaseDate: "2016-11-11",
  overview: "A synthetic search result.",
  posterPath: null,
}];
let receivedMovieQuery = "";
let receivedMovieLanguage = "";
const staticDirectory = path.join(temporaryRoot, "static");
mkdirSync(staticDirectory);
writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>Fixture</title>");
copyFileSync(path.join(process.cwd(), "public", "visualization-runner.html"), path.join(staticDirectory, "visualization-runner.html"));
copyFileSync(path.join(process.cwd(), "public", "visualization-runner.js"), path.join(staticDirectory, "visualization-runner.js"));
const app = createApp(database, staticDirectory, {
  movieSearch: {
    async search(query, language) {
      receivedMovieQuery = query;
      receivedMovieLanguage = language;
      return mockResults;
    },
  },
});
const server = app.listen(0, "127.0.0.1");
let baseUrl = "";

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeDatabase(database);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

async function post(pathname: string, body: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  return { response, body: await response.json() as ApiResponseBody };
}

function viewBlock(sourceText: string): string {
  const block = viewBlocks(sourceText)[0];
  assert.ok(block);
  return block;
}

function viewBlocks(sourceText: string): string[] {
  return [...sourceText.matchAll(/```fieldnotes-view\n[\s\S]*?\n```/gu)].map((match) => match[0]);
}

test("synthetic dashboard fixtures parse to table, calendar, and trusted custom views", () => {
  const goalConfig = parseFieldnotesViewConfig(viewBlock(dashboards[0] ?? ""));
  const articleConfig = parseFieldnotesViewConfig(viewBlock(dashboards[1] ?? ""));
  const babyConfig = parseFieldnotesViewConfig(viewBlock(dashboards[2] ?? ""));
  const movieConfig = parseFieldnotesViewConfig(viewBlock(dashboards[3] ?? ""));
  assert.equal(goalConfig.view, "custom");
  assert.equal(articleConfig.view, "table");
  assert.equal(babyConfig.view, "calendar");
  assert.equal(movieConfig.view, "custom");
  assert.equal(babyConfig.dateField, "frontmatter.date");
  assert.match(goalConfig.js ?? "", /note\.trash/u);
  assert.match(goalConfig.js ?? "", /trash\.restore/u);
  assert.match(parseFieldnotesViewConfig(viewBlocks(dashboards[1] ?? "")[1] ?? "").js ?? "", /note\.open/u);
  assert.match(parseFieldnotesViewConfig(viewBlocks(dashboards[2] ?? "")[1] ?? "").js ?? "", /note\.create/u);
});

test("sandbox action messages parse into the bounded host event vocabulary", () => {
  assert.deepEqual(parseVisualizationUiEvent({ type: "note.create", fields: { title: "Synthetic goal", body: "Fixture body" } }), {
    type: "note.create", fields: { title: "Synthetic goal", body: "Fixture body" },
  });
  assert.deepEqual(parseVisualizationUiEvent({ type: "state.set", key: "filter", value: { active: true, tags: ["goal"] } }), {
    type: "state.set", key: "filter", value: { active: true, tags: ["goal"] },
  });
  assert.equal(parseVisualizationUiEvent({ type: "note.trash", noteId: "../outside" }), null);
  const unsafeFields: unknown = JSON.parse('{"type":"note.create","fields":{"title":"Goal","__proto__":"field"}}');
  assert.equal(parseVisualizationUiEvent(unsafeFields), null);
  assert.equal(parseVisualizationUiEvent({ type: "state.set", key: "__proto__", value: true }), null);
  assert.equal(parseVisualizationUiEvent({ type: "note.update", noteId: goal.id, fields: {}, extra: true }), null);
  assert.equal(parseVisualizationUiEvent({ type: "arbitrary", fields: {} }), null);
});

test("read-only query filters fixture metadata without returning note bodies and refreshes after a committed action", async () => {
  const before = Number((database.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes").get() as { seq: number }).seq);
  const response = await post("/api/views/query", {
    query: {
      where: [{ field: "frontmatter.type", operator: "eq", value: "milestone" }],
      sort: { field: "frontmatter.date", direction: "asc" },
      limit: 5,
    },
  });
  assert.equal(response.response.status, 200);
  const notes = response.body.notes ?? [];
  assert.deepEqual(notes.map((note) => note.id), [baby.id]);
  assert.equal(notes[0]?.version, baby.version);
  assert.match(notes[0]?.contentHash ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(notes[0] ?? {}, "body"), false);
  assert.equal(response.body.sequence, before);

  const articles = await post("/api/views/query", { query: { where: [{ field: "frontmatter.type", operator: "eq", value: "article" }] } });
  const articleNotes = articles.body.notes ?? [];
  assert.deepEqual(articleNotes.map((entry) => entry.id), [article.id]);
  const articleNote = articleNotes[0];
  assert.ok(articleNote);
  const changed = await post("/api/views/actions", {
    type: "note.update", id: article.id, expectedVersion: articleNote.version,
    expectedHash: articleNote.contentHash, title: "Updated fixture article", body: "Changed by the host action bridge.",
  });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.note?.title, "Updated fixture article");
  assert.equal((await (await fetch(`${baseUrl}/api/documents/${article.id}`)).json() as { document: { body: string } }).document.body, "Changed by the host action bridge.");
});

test("create, patch, conflict, trash, and restore preserve exact Markdown and publish live changes", async () => {
  const queried = await post("/api/views/query", { query: { where: [{ field: "title", operator: "eq", value: "Fixture goal" }] } });
  const note = queried.body.notes?.[0];
  assert.ok(note);
  assert.equal(note.id, goal.id);
  const changes: Array<{ operation: string; documentId?: string }> = [];
  const listener = (change: { operation: string; documentId?: string }) => changes.push(change);
  database.changes.on("change", listener);
  try {
    const updated = await post("/api/views/actions", {
      type: "note.frontmatter.patch",
      id: note.id,
      expectedVersion: note.version,
      expectedHash: note.contentHash,
      patch: { status: "completed" },
    });
    assert.equal(updated.response.status, 200);
    const latest = (await post("/api/views/query", { query: { search: "Fixture goal" } })).body.notes?.[0];
    assert.ok(latest);
    const expected = source.replace("status: active # keep this comment", 'status: "completed" # keep this comment');
    assert.equal((await (await fetch(`${baseUrl}/api/documents/${goal.id}`)).json() as { document: { body: string } }).document.body, expected);
    assert.deepEqual(parseFrontmatter(expected).values.status, "completed");
    assert.equal(latest.version, note.version + 1);
    assert.ok(changes.some((change) => change.documentId === goal.id && change.operation === "updated"));

    const stale = await post("/api/views/actions", {
      type: "note.update", id: note.id, expectedVersion: note.version, expectedHash: note.contentHash, title: "Stale write",
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error, "version_conflict");

    const trashed = await post("/api/views/actions", {
      type: "note.trash", id: goal.id, expectedVersion: latest.version, expectedHash: latest.contentHash,
    });
    assert.equal(trashed.response.status, 200);
    const normalQuery = await post("/api/views/query", { query: { search: "Fixture goal" } });
    assert.equal((normalQuery.body.notes ?? []).some((entry) => entry.id === goal.id), false);
    const withTrash = await post("/api/views/query", { query: { search: "Fixture goal", includeTrash: true } });
    const trashEntry = (withTrash.body.trash ?? []).find((entry) => entry.id === goal.id);
    assert.ok(trashEntry);
    assert.equal(Object.hasOwn(trashEntry, "body"), false);
    const restored = await post("/api/views/actions", { type: "trash.restore", id: goal.id, expectedVersion: trashEntry.version });
    assert.equal(restored.response.status, 200);
    const final = await post("/api/views/query", { query: { search: "Fixture goal" } });
    assert.ok((final.body.notes ?? []).some((entry) => entry.id === goal.id));
    assert.equal((await (await fetch(`${baseUrl}/api/documents/${goal.id}`)).json() as { document: { body: string } }).document.body, expected);
    assert.ok(changes.some((change) => change.documentId === goal.id && change.operation === "deleted"));
    assert.ok(changes.some((change) => change.documentId === goal.id && change.operation === "created"));
  } finally {
    database.changes.off("change", listener);
  }
});

test("create actions are idempotent and reject action-id reuse with a different payload", async () => {
  const actionId = randomUUID();
  const action = { type: "note.create", actionId, title: "Action-created goal", body: "Body", frontmatter: { type: "goal", status: "active" } };
  const created = await post("/api/views/actions", action);
  const repeated = await post("/api/views/actions", action);
  assert.equal(created.response.status, 201);
  assert.equal(repeated.response.status, 200);
  assert.equal(created.body.note?.id, actionId);
  assert.equal(repeated.body.note?.id, actionId);
  assert.equal(Object.hasOwn(created.body.note ?? {}, "body"), false);
  const collision = await post("/api/views/actions", { ...action, title: "Different payload" });
  assert.equal(collision.response.status, 409);
});

test("trash view queries cap candidates at the runner limit and enforce a byte budget", async () => {
  for (let index = 0; index < 101; index += 1) {
    const created = createDocument(database, `Trash candidate ${index}`, `Synthetic trash body ${index}.`);
    trashDocument(database, created.id, created.version, created.contentHash);
  }
  const response = await post("/api/views/query", { query: { includeTrash: true, limit: 200 } });
  assert.equal(response.response.status, 200);
  assert.equal(response.body.trash?.length, 100);
  assert.throws(() => listTrashedDocuments(database, 100, 1), ViewQueryLimitError);

  const largeBody = "x".repeat(250_000);
  for (let index = 0; index < 81; index += 1) {
    const created = createDocument(database, `Large trash candidate ${index}`, largeBody);
    trashDocument(database, created.id, created.version, created.contentHash);
  }
  const overBudget = await post("/api/views/query", { query: { includeTrash: true, limit: 200 } });
  assert.equal(overBudget.response.status, 413);
  assert.equal(overBudget.body.error, "invalid_view_query");
});

test("TMDb search uses only the injected mock adapter and returns bounded fixture results", async () => {
  const response = await post("/api/views/actions", { type: "movies.search", provider: "tmdb", query: " Arrival ", language: "en-US" });
  assert.equal(response.response.status, 200);
  assert.equal(receivedMovieQuery, "Arrival");
  assert.equal(receivedMovieLanguage, "en-US");
  assert.deepEqual(response.body.results, mockResults);
  const unsupported = await post("/api/views/actions", { type: "movies.search", provider: "arbitrary", query: "Arrival" });
  assert.equal(unsupported.response.status, 400);
});

test("TMDb adapter uses a fixed official endpoint and bearer token only through a mocked fetch", async () => {
  let requestedUrl: URL | undefined;
  let authorization = "";
  const adapter = new TmdbMovieSearchAdapter("synthetic-access-token", async (input, init) => {
    requestedUrl = new URL(String(input));
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return new Response(JSON.stringify({ results: [
      { id: 7, title: "Arrival", original_title: "Arrival", release_date: "2016-11-11", overview: "Fixture.", poster_path: "/sample.jpg" },
      { id: "invalid", title: "Ignore this row" },
    ] }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const results = await adapter.search("Arrival", "en-US");
  assert.equal(requestedUrl?.origin, "https://api.themoviedb.org");
  assert.equal(requestedUrl?.pathname, "/3/search/movie");
  assert.equal(requestedUrl?.searchParams.get("query"), "Arrival");
  assert.equal(requestedUrl?.searchParams.get("include_adult"), "false");
  assert.equal(requestedUrl?.searchParams.get("language"), "en-US");
  assert.equal(authorization, "Bearer synthetic-access-token");
  assert.deepEqual(results, [{
    id: 7, title: "Arrival", originalTitle: "Arrival", releaseDate: "2016-11-11",
    overview: "Fixture.", posterPath: "/sample.jpg",
  }]);
});

test("filesystem trash is private and restore handles a folder deleted while the note was trashed", () => {
  const dataDirectory = path.join(temporaryRoot, "fs-data");
  const vaultDirectory = path.join(dataDirectory, "vaults", "default");
  const fsDatabase = openDatabase(dataDirectory, { seedDemo: false, vaultDir: vaultDirectory });
  try {
    const folder = fsDatabase.vault?.createFolder("Disposable", null);
    assert.ok(folder);
    const created = createDocument(fsDatabase, "File note", "Original file body.", folder.folder.id);
    const originalPath = path.join(vaultDirectory, created.filePath ?? "");
    const trashed = trashDocument(fsDatabase, created.id, created.version, created.contentHash);
    assert.equal(readFileSync(path.join(vaultDirectory, ".fieldnotes", "trash", `${created.id}.md`), "utf8"), "Original file body.");
    assert.equal(fsDatabase.vault?.snapshot().documents.some((entry) => entry.id === created.id), false);
    assert.throws(() => fsDatabase.vault?.listTrashedDocuments(100, 1), ViewQueryLimitError);
    fsDatabase.vault?.deleteFolder(folder.folder.id, folder.folder.version);
    const restored = restoreTrashedDocument(fsDatabase, created.id, trashed.version);
    assert.equal(restored.folderId, null);
    assert.equal(restored.version, created.version + 1);
    assert.equal(readFileSync(path.join(vaultDirectory, restored.filePath ?? ""), "utf8"), "Original file body.");
    assert.equal(fsDatabase.vault?.listTrashedDocuments().length, 0);
    assert.equal(existsSync(originalPath), false);
  } finally {
    closeDatabase(fsDatabase);
  }
});

test("filesystem view queries use the bounded index without triggering a full vault rescan", async () => {
  const dataDirectory = path.join(temporaryRoot, "query-fs-data");
  const vaultDirectory = path.join(dataDirectory, "vaults", "default");
  const fsDatabase = openDatabase(dataDirectory, { seedDemo: false, vaultDir: vaultDirectory });
  const created = createDocument(fsDatabase, "Indexed fixture", "Cached synthetic content.");
  const vault = fsDatabase.vault;
  assert.ok(vault);
  let reconcileCount = 0;
  const reconcile = vault.reconcile.bind(vault);
  vault.reconcile = () => {
    reconcileCount += 1;
    return reconcile();
  };
  const queryServer = createApp(fsDatabase).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    queryServer.once("listening", resolve);
    queryServer.once("error", reject);
  });
  const address = queryServer.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/views/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: { search: "Indexed fixture" } }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { notes: Array<{ id: string }> };
    assert.ok(result.notes.some((note) => note.id === created.id));
    assert.equal(reconcileCount, 0);

    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(reconcileCount, 1);
  } finally {
    await new Promise<void>((resolve, reject) => queryServer.close((error) => error ? reject(error) : resolve()));
    closeDatabase(fsDatabase);
  }
});

test("TMDb provider is disabled unless an approved adapter is injected", async () => {
  const unconfigured = createApp(database);
  const isolated = unconfigured.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    isolated.once("listening", resolve);
    isolated.once("error", reject);
  });
  const address = isolated.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/views/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "movies.search", provider: "tmdb", query: "Arrival" }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 503);
  } finally {
    await new Promise<void>((resolve) => isolated.close(() => resolve()));
  }
});
