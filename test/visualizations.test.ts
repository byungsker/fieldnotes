import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/api.js";
import { closeDatabase, createDocument, openDatabase } from "../server/database.js";
import { parseFrontmatter } from "../server/frontmatter.js";

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "fieldnotes-views-test-"));
const database = openDatabase(path.join(temporaryRoot, "data"), { seedDemo: false });
const fixtureDirectory = path.join(process.cwd(), "test", "fixtures");
const first = createDocument(database, "Alpha plan", readFileSync(path.join(fixtureDirectory, "view-active.md"), "utf8"));
createDocument(database, "Beta plan", readFileSync(path.join(fixtureDirectory, "view-complete.md"), "utf8"));

const staticDirectory = path.join(temporaryRoot, "static");
mkdirSync(staticDirectory);
writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>Fixture</title>");
copyFileSync(path.join(process.cwd(), "public", "visualization-runner.html"), path.join(staticDirectory, "visualization-runner.html"));
copyFileSync(path.join(process.cwd(), "public", "visualization-runner.js"), path.join(staticDirectory, "visualization-runner.js"));
const app = createApp(database, staticDirectory);
const server = app.listen(0, "127.0.0.1");
let baseUrl = "";

before(async () => {
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeDatabase(database);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

test("frontmatter reads safe scalars, lists, quoted values, and nested mappings", () => {
  const parsed = parseFrontmatter([
    "---",
    "title: 'A note: with colon'",
    "active: true",
    "score: 5",
    "tags: [one, 'two, three']",
    "owner:",
    "  name: Mira",
    "---",
    "body",
  ].join("\n"));
  assert.deepEqual(parsed.error, undefined);
  assert.deepEqual(parsed.values, {
    title: "A note: with colon",
    active: true,
    score: 5,
    tags: ["one", "two, three"],
    owner: { name: "Mira" },
  });
});

test("view query is read-only and filters, sorts, and limits fixture notes", async () => {
  const beforeSequence = Number((database.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes").get() as { seq: number }).seq);
  const response = await fetch(`${baseUrl}/api/views/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: {
        where: [
          { field: "frontmatter.status", operator: "eq", value: "active" },
          { field: "frontmatter.tags", operator: "contains", value: "family" },
        ],
        sort: { field: "frontmatter.score", direction: "desc" },
        limit: 1,
      },
    }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { notes: Array<Record<string, unknown>>; sequence: number };
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0]?.id, first.id);
  assert.deepEqual(result.notes[0]?.frontmatter, { status: "active", score: 5, due: "2025-01-15", tags: ["family", "reading"], owner: { name: "Mira" } });
  assert.equal(Object.hasOwn(result.notes[0] ?? {}, "body"), false);
  const afterSequence = Number((database.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes").get() as { seq: number }).seq);
  assert.equal(result.sequence, beforeSequence);
  assert.equal(afterSequence, beforeSequence);
});

test("host returns a realistic 44-note dashboard fixture within query-result limits", async () => {
  const categories = [
    ...Array.from({ length: 41 }, () => "record"),
    "watchlist",
    "watchlist",
    "dashboard",
  ];
  categories.forEach((kind, index) => {
    createDocument(database, `Synthetic movie note ${index + 1}`, [
      "---",
      "fixture: movie-dashboard-synthetic",
      `kind: ${kind}`,
      `syntheticIndex: ${index + 1}`,
      "year: 2024",
      "tags: [synthetic, catalog]",
      "---",
      "Synthetic metadata for the full-size host query fixture.",
    ].join("\n"));
  });

  const response = await fetch(`${baseUrl}/api/views/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: {
      where: [{ field: "frontmatter.fixture", operator: "eq", value: "movie-dashboard-synthetic" }],
      limit: 100,
    } }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { notes: Array<{ frontmatter: { kind?: string } }>; sequence: number };
  assert.equal(result.notes.length, 44);
  assert.equal(result.notes.filter((note) => note.frontmatter.kind === "record").length, 41);
  assert.equal(result.notes.filter((note) => note.frontmatter.kind === "watchlist").length, 2);
  assert.equal(result.notes.filter((note) => note.frontmatter.kind === "dashboard").length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 1_500_000, "host result fits MAX_RESULT_BYTES");
  assert.ok(JSON.stringify(result).length < 1_000_000, "host result fits the runner input cap");
  assert.ok(result.notes.every((note) => !Object.hasOwn(note, "body")), "query results stay metadata-only");
});

test("view query follows newly saved notes on the next read", async () => {
  const created = await fetch(`${baseUrl}/api/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Fresh fixture", body: "---\nstatus: active\n---\nCreated for live refresh." }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(created.status, 201);
  const response = await fetch(`${baseUrl}/api/views/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: { where: [{ field: "frontmatter.status", operator: "eq", value: "active" }] } }),
    signal: AbortSignal.timeout(5_000),
  });
  const result = await response.json() as { notes: Array<{ title: string }>; sequence: number };
  assert.equal(response.status, 200);
  assert.ok(result.notes.some((note) => note.title === "Fresh fixture"));
  assert.ok(result.sequence > 0);
});

test("view query rejects unsupported selectors and operators", async () => {
  for (const query of [
    { where: [{ field: "body", operator: "eq", value: "secret" }] },
    { where: [{ field: "frontmatter.status", operator: "execute", value: "active" }] },
    { sort: { field: "path", direction: "sideways" } },
    { unknown: true },
  ]) {
    const response = await fetch(`${baseUrl}/api/views/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 400);
  }
});

test("runner document has a sandbox-specific no-network policy", async () => {
  const response = await fetch(`${baseUrl}/visualization-runner.html`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  const policy = response.headers.get("content-security-policy") ?? "";
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /script-src 'sha256-[A-Za-z0-9+/=]+' blob:/);
  assert.match(policy, /script-src-elem 'sha256-[A-Za-z0-9+/=]+' blob:/);
  assert.doesNotMatch(policy, /script-src 'self'/);
  assert.match(policy, /img-src 'self'/);
  assert.match(policy, /font-src 'none'/);
  assert.match(policy, /frame-src 'none'/);
  assert.match(policy, /child-src 'none'/);
  assert.match(policy, /worker-src blob:/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  const html = await response.text();
  assert.match(html, /visualization-runner\.js/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /img-src 'self'/);
});

test("runner script is readable by its opaque frame origin only as a static CORS resource", async () => {
  const response = await fetch(`${baseUrl}/visualization-runner.js`, {
    headers: { Origin: "null" },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
});
