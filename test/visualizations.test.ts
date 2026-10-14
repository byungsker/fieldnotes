import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
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

type RunnerFixtureNode = {
  nodeType: number;
  localName: string;
  attributes: Array<{ name: string; value: string }>;
  childNodes: RunnerFixtureNode[];
  append(node: RunnerFixtureNode): void;
  setAttribute(name: string, value: string): void;
};

function runnerFixtureNode(nodeType: number, localName: string, attributes: Array<{ name: string; value: string }> = []): RunnerFixtureNode {
  return {
    nodeType,
    localName,
    attributes,
    childNodes: [],
    append(node) { this.childNodes.push(node); },
    setAttribute(name, value) { this.attributes.push({ name, value }); },
  };
}

function runnerFixtureContext(): vm.Context {
  const root = Object.assign(runnerFixtureNode(1, "div"), {
    addEventListener: () => undefined,
    querySelectorAll: () => [],
    dataset: {},
  });
  const body = runnerFixtureNode(1, "body");
  const documentElement = runnerFixtureNode(1, "html");
  const head = runnerFixtureNode(1, "head");
  const context = vm.createContext({
    URLSearchParams,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    window: { location: { search: "" }, parent: {}, addEventListener: () => undefined },
    document: {
      getElementById: (id: string) => id === "root" ? root : null,
      body,
      documentElement,
      head,
      createDocumentFragment: () => runnerFixtureNode(11, "#fragment"),
      createTextNode: () => runnerFixtureNode(3, "#text"),
      createElement: (name: string) => runnerFixtureNode(1, name),
    },
    DOMParser: class {
      parseFromString(markup: string) {
        const parsedBody = runnerFixtureNode(1, "body");
        for (const match of markup.matchAll(/<img\b([^>]*)>/giu)) {
          const attributes = [...(match[1] ?? "").matchAll(/([A-Za-z][A-Za-z0-9-]*)="([^"]*)"/gu)]
            .map((attribute) => ({ name: (attribute[1] ?? "").toLowerCase(), value: attribute[2] ?? "" }));
          parsedBody.append(runnerFixtureNode(1, "img", attributes));
        }
        return { body: parsedBody };
      }
    },
  });
  const runnerSource = readFileSync(path.join(process.cwd(), "public", "visualization-runner.js"), "utf8");
  vm.runInContext(runnerSource, context);
  return context;
}

function countRunnerFixtureNodesNamed(node: RunnerFixtureNode, localName: string): number {
  return (node.nodeType === 1 && node.localName === localName ? 1 : 0)
    + node.childNodes.reduce((count, child) => count + countRunnerFixtureNodesNamed(child, localName), 0);
}

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
    const notePath = kind === "record"
      ? `movies/records/record-${index + 1}.md`
      : kind === "watchlist"
        ? `movies/watchlist/watch-${index + 1}.md`
        : "movies/dashboard.md";
    const created = createDocument(database, `Synthetic movie note ${index + 1}`, [
      "---",
      "fixture: movie-dashboard-synthetic",
      `kind: ${kind}`,
      `syntheticIndex: ${index + 1}`,
      ...(kind === "dashboard"
        ? ["month: 2025-01", "tags: [synthetic, dashboard]"]
        : [
          `year: ${kind === "record" ? 2024 : 2025}`,
          `status: ${kind === "record" ? "watched" : "planned"}`,
          "rating: 7.4",
          "tags: [synthetic, catalog]",
        ]),
      "---",
      kind === "dashboard"
        ? "Synthetic metadata for the full-size dashboard query fixture."
        : `![Poster](../posters/${kind}-${index + 1}.jpg)`,
    ].join("\n"));
    database.db.prepare("UPDATE documents SET file_path = ? WHERE id = ?").run(notePath, created.id);
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
  const result = await response.json() as {
    notes: Array<{ id: string; contentHash: string; frontmatter: { kind?: string }; path: string; assetPaths?: string[] }>;
    sequence: number;
  };
  assert.equal(result.notes.length, 44);
  assert.equal(result.notes.filter((note) => note.frontmatter.kind === "record").length, 41);
  assert.equal(result.notes.filter((note) => note.frontmatter.kind === "watchlist").length, 2);
  assert.equal(result.notes.filter((note) => note.frontmatter.kind === "dashboard").length, 1);
  const imageNotes = result.notes.filter((note) => note.frontmatter.kind !== "dashboard");
  assert.equal(imageNotes.length, 43);
  assert.ok(imageNotes.every((note) => note.assetPaths?.length === 1), "host query derives local image metadata from note Markdown");
  assert.ok(imageNotes.every((note) => note.assetPaths?.[0]?.startsWith("movies/posters/")), "asset paths are vault-relative normalized paths");
  assert.ok(result.notes.every((note) => Object.keys(note.frontmatter).length > 0), "the fixture uses parsed movie metadata");

  const fixtureRunner = runnerFixtureContext();
  fixtureRunner.__fixtureNotes = result.notes;
  fixtureRunner.__fixtureHtml = imageNotes.map((note) => {
    const assetPath = note.assetPaths?.[0];
    assert.ok(assetPath);
    return `<img src="/api/views/assets/${note.id}?asset=${encodeURIComponent(assetPath)}&v=${note.contentHash}" alt="Synthetic poster">`;
  }).join("");
  const allowedImageSources = vm.runInContext("buildAllowedImageSources(__fixtureNotes)", fixtureRunner) as Set<string>;
  assert.equal(allowedImageSources.size, 43, "the actual runner builder derives asset URLs from actual host query metadata");
  const sanitized = vm.runInContext("sanitizeMarkup(__fixtureHtml, buildAllowedImageSources(__fixtureNotes))", fixtureRunner) as RunnerFixtureNode;
  assert.equal(countRunnerFixtureNodesNamed(sanitized, "img"), 43, "all host-derived local posters survive the real sanitizer");
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
