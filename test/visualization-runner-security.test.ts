import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parseFieldnotesViewConfig } from "../packages/markdown-live-editor/fieldnotes-view-config.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerSource = readFileSync(path.join(projectRoot, "public/visualization-runner.js"), "utf8");
const runnerHtml = readFileSync(path.join(projectRoot, "public/visualization-runner.html"), "utf8");
const apiSource = readFileSync(path.join(projectRoot, "server/api.ts"), "utf8");
const assetSource = readFileSync(path.join(projectRoot, "server/visualization-assets.ts"), "utf8");
const editorSource = readFileSync(path.join(projectRoot, "packages/markdown-live-editor/SandboxedVisualization.tsx"), "utf8");
const viewBlockSource = readFileSync(path.join(projectRoot, "packages/markdown-live-editor/FieldnotesViewBlock.tsx"), "utf8");
const adaptersSource = readFileSync(path.join(projectRoot, "src/pages/workspace/api/editor-adapters.ts"), "utf8");
const frameHeightSource = readFileSync(path.join(projectRoot, "packages/markdown-live-editor/visualization-frame-height.ts"), "utf8");
const appSource = readFileSync(path.join(projectRoot, "src/pages/workspace/ui/WorkspacePage.tsx"), "utf8");
const runnerScriptHash = `sha256-${createHash("sha256").update(runnerSource).digest("base64")}`;

function generatedWorkerSource(javascript = 'return { html: "<p>fixture</p>", css: "" };'): string {
  const context = vm.createContext({
    URLSearchParams,
    window: { location: { search: "" }, parent: {}, addEventListener: () => undefined },
    document: { getElementById: () => ({ textContent: "", replaceChildren: () => undefined, addEventListener: () => undefined }) },
  });
  vm.runInContext(`${runnerSource}\n;globalThis.__generatedWorker = buildWorkerSource(${JSON.stringify(javascript)});`, context);
  return context.__generatedWorker as string;
}

function workerContext(renderSource: string): { context: vm.Context; source: string } {
  const context = vm.createContext({
    __messages: [] as unknown[],
    Blob: class Blob { constructor(readonly parts: unknown[]) {} },
    URL: { createObjectURL: () => "blob:synthetic", revokeObjectURL: () => undefined },
  });
  vm.runInContext(`
    self = globalThis;
    const simulatedWorkerPrototype = Object.create(Object.getPrototypeOf(self));
    simulatedWorkerPrototype.fetch = () => "blocked inherited fetch";
    simulatedWorkerPrototype.WebSocket = function WebSocket() {};
    simulatedWorkerPrototype.importScripts = () => "blocked inherited importScripts";
    Object.setPrototypeOf(self, simulatedWorkerPrototype);
    self.postMessage = (message) => __messages.push(message);
    self.importScripts = () => {
      self.fieldnotesRender = function(notes, escapeHtml, state, trash) { ${renderSource} };
    };
  `, context);
  const source = generatedWorkerSource(renderSource);
  new vm.Script(source).runInContext(context);
  return { context, source };
}

type SyntheticDomNode = {
  nodeType: number;
  localName: string;
  attributes: Array<{ name: string; value: string }>;
  childNodes: SyntheticDomNode[];
  append(node: SyntheticDomNode): void;
  setAttribute(name: string, value: string): void;
};

function syntheticDomNode(nodeType: number, localName: string, attributes: Array<{ name: string; value: string }> = []): SyntheticDomNode {
  const node: SyntheticDomNode = {
    nodeType,
    localName,
    attributes,
    childNodes: [],
    append(child) { this.childNodes.push(child); },
    setAttribute(name, value) { this.attributes.push({ name, value }); },
  };
  return node;
}

function parseSyntheticMarkup(markup: string): SyntheticDomNode[] {
  const body = syntheticDomNode(1, "body");
  const stack = [body];
  const voidTags = new Set(["br", "hr", "img", "input"]);
  for (const match of markup.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)\b([^>]*)>/gu)) {
    const token = match[0] ?? "";
    const name = (match[1] ?? "").toLowerCase();
    if (token.startsWith("</")) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index]?.localName === name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const attributes = [...(match[2] ?? "").matchAll(/([A-Za-z][A-Za-z0-9-]*)="([^"]*)"/gu)]
      .map((attribute) => ({ name: (attribute[1] ?? "").toLowerCase(), value: attribute[2] ?? "" }));
    const element = syntheticDomNode(1, name, attributes);
    stack.at(-1)?.append(element);
    if (!voidTags.has(name)) stack.push(element);
  }
  return body.childNodes;
}

function sanitizerContext(): vm.Context {
  const root = Object.assign(syntheticDomNode(1, "div"), {
    addEventListener: () => undefined,
    querySelectorAll: () => [],
  });
  const body = syntheticDomNode(1, "body");
  const documentElement = syntheticDomNode(1, "html");
  const head = syntheticDomNode(1, "head");
  const context = vm.createContext({
    URLSearchParams,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    window: { location: { search: "" }, parent: {}, addEventListener: () => undefined },
    document: {
      getElementById: (id: string) => id === "root" ? root : null,
      body,
      documentElement,
      head,
      createDocumentFragment: () => syntheticDomNode(11, "#fragment"),
      createTextNode: () => syntheticDomNode(3, "#text"),
      createElement: (name: string) => syntheticDomNode(1, name),
    },
    DOMParser: class {
      parseFromString(markup: string) { return { body: { childNodes: parseSyntheticMarkup(markup) } }; }
    },
  });
  vm.runInContext(runnerSource, context);
  return context;
}

function countSyntheticDomElements(node: SyntheticDomNode): number {
  return (node.nodeType === 1 ? 1 : 0) + node.childNodes.reduce((count, child) => count + countSyntheticDomElements(child), 0);
}

function countSyntheticDomElementsNamed(node: SyntheticDomNode, localName: string): number {
  return (node.nodeType === 1 && node.localName === localName ? 1 : 0)
    + node.childNodes.reduce((count, child) => count + countSyntheticDomElementsNamed(child, localName), 0);
}

test("runner CSP permits only the static host script and Blob worker source", () => {
  const header = apiSource.match(/visualizationRunner\s*\n\s*\?\s*"([^"]+)"/)?.[1];
  const meta = runnerHtml.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(header);
  assert.ok(meta);
  for (const policy of [header, meta]) {
    assert.ok(policy.includes(`script-src '${runnerScriptHash}' blob:`));
    assert.ok(policy.includes(`script-src-elem '${runnerScriptHash}' blob:`));
    assert.doesNotMatch(policy, /script-src 'self'/);
    assert.doesNotMatch(policy, /script-src-elem 'self'/);
    for (const directive of ["connect-src 'none'", "img-src 'self'", "font-src 'none'", "media-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src blob:"]) {
      assert.ok(policy.includes(directive), `missing CSP directive ${directive}`);
    }
    assert.doesNotMatch(policy, /unsafe-eval/);
  }
  assert.match(header, /frame-ancestors 'self'/);
  assert.match(editorSource, /sandbox="allow-scripts allow-forms"/);
  assert.doesNotMatch(editorSource, /sandbox="[^"]*allow-same-origin|sandbox="[^"]*allow-top-navigation/u);
  assert.match(editorSource, /referrerPolicy="no-referrer"/i);
  assert.ok(runnerHtml.includes(`integrity="${runnerScriptHash}"`));
});

test("runner reconnects when the view block is reopened and reuses its iframe", () => {
  const parentMessages: unknown[] = [];
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const parent = { postMessage: (message: unknown) => parentMessages.push(message) };
  const root = {
    textContent: "",
    dataset: {} as Record<string, string>,
    scrollHeight: 100,
    addEventListener: () => undefined,
  };
  const context = vm.createContext({
    URLSearchParams,
    window: {
      location: { search: "?parentOrigin=https%3A%2F%2Fnotes.example" },
      parent,
      addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => handlers.set(type, handler),
      removeEventListener: (type: string) => handlers.delete(type),
    },
    document: { getElementById: () => root, body: { scrollHeight: 100 }, documentElement: { scrollHeight: 100 } },
  });
  vm.runInContext(runnerSource, context);
  const onMessage = handlers.get("message");
  assert.ok(onMessage);
  const origin = "https://notes.example";
  onMessage({ source: parent, origin, data: { type: "fieldnotes-view-ping" }, ports: [] });
  assert.equal((parentMessages[0] as { type?: string }).type, "fieldnotes-view-runner-ready");

  const makePort = () => ({ started: false, closed: false, onmessage: null as null | ((event: { data: unknown }) => void), messages: [] as unknown[], start() { this.started = true; }, close() { this.closed = true; }, postMessage(message: unknown) { this.messages.push(message); } });
  const firstPort = makePort();
  onMessage({ source: parent, origin, data: { type: "fieldnotes-view-connect" }, ports: [firstPort] });
  assert.equal(firstPort.started, true);
  assert.deepEqual(firstPort.messages.map((message) => (message as { type?: string }).type), ["ready"]);

  const secondPort = makePort();
  onMessage({ source: parent, origin, data: { type: "fieldnotes-view-connect" }, ports: [secondPort] });
  assert.equal(firstPort.closed, true);
  assert.equal(secondPort.started, true);
  assert.deepEqual(secondPort.messages.map((message) => (message as { type?: string }).type), ["ready"]);
  assert.equal(handlers.get("message"), onMessage);
});

test("custom runner reports bounded content height to the host for normal page scrolling", () => {
  const sandboxSource = readFileSync(path.join(projectRoot, "packages/markdown-live-editor/SandboxedVisualization.tsx"), "utf8");
  const stylesSource = readFileSync(path.join(projectRoot, "packages/markdown-live-editor/styles.css"), "utf8");
  assert.match(runnerSource, /new ResizeObserver\(scheduleFrameHeightReport\)/u);
  assert.match(runnerSource, /type: "resize"/u);
  assert.match(runnerSource, /sendToHost\(\{ type: "complete", requestId: message\.requestId \}\);\s*reportFrameHeight\(\);\s*scheduleFrameHeightReport\(\);/u);
  assert.match(sandboxSource, /message\.type === "resize"/u);
  assert.match(sandboxSource, /boundedVisualizationFrameHeight\(message\.height\)/u);
  assert.match(frameHeightSource, /MAX_VISUALIZATION_FRAME_HEIGHT = 16_000/u);
  assert.doesNotMatch(stylesSource, /iframe[^\n]*max-height:\s*\d+vh/u);
  assert.match(stylesSource, /\.mle-fieldnotes-view-block\s*\{[^}]*overflow-x:\s*clip;[^}]*overflow-y:\s*visible;/su);
});

test("frame height follows page content without adding clipped nested-scroll overflow", () => {
  const sent: Array<{ type?: string; height?: number; requestId?: number }> = [];
  const nestedScroller = {
    scrollHeight: 1_100,
    clientHeight: 200,
    scrollWidth: 1_100,
    clientWidth: 370,
  };
  const root = {
    scrollHeight: 300,
    addEventListener: () => undefined,
    querySelectorAll: () => [nestedScroller],
  };
  const body = { scrollHeight: 300, addEventListener: () => undefined };
  const documentElement = { scrollHeight: 300 };
  const context = vm.createContext({
    __sent: sent,
    URLSearchParams,
    requestAnimationFrame: (callback: () => void) => callback(),
    window: { location: { search: "" }, parent: {}, addEventListener: () => undefined },
    document: { getElementById: () => root, body, documentElement, head: {} },
  });
  vm.runInContext(runnerSource, context);
  vm.runInContext("activeRequestId = 17; hostPort = { postMessage: (message) => globalThis.__sent.push(message) }; reportFrameHeight();", context);

  const message = sent[0];
  assert.equal(message?.type, "resize");
  assert.equal(message?.requestId, 17);
  assert.equal(message?.height, 300, "a fixed-height nested scroller remains independently scrollable without blank iframe height");

  root.scrollHeight = 1_240;
  body.scrollHeight = 1_240;
  documentElement.scrollHeight = 1_240;
  vm.runInContext("reportFrameHeight()", context);
  assert.equal(sent[1]?.height, 1_240, "ordinary page content still grows the outer frame");
});

test("runner unobserves descendants removed by repeated render replacements", () => {
  const observed = new Set<object>();
  const children: object[] = [];
  const root = { addEventListener: () => undefined, querySelectorAll: () => children };
  const body = {};
  const documentElement = {};
  const context = vm.createContext({
    URLSearchParams,
    ResizeObserver: class {
      observe(element: object) { observed.add(element); }
      unobserve(element: object) { observed.delete(element); }
    },
    window: { location: { search: "" }, parent: {}, addEventListener: () => undefined },
    document: { getElementById: () => root, body, documentElement, head: {} },
  });
  vm.runInContext(runnerSource, context);

  const oldTargets = [{}, {}];
  children.push(...oldTargets);
  vm.runInContext("observeFrameContent()", context);
  assert.ok(oldTargets.every((element) => observed.has(element)));

  children.splice(0, children.length, {});
  const currentTarget = children[0];
  vm.runInContext("observeFrameContent()", context);
  assert.ok(oldTargets.every((element) => !observed.has(element)));
  assert.ok(observed.has(currentTarget));
  assert.equal(observed.size, 4, "only the root, document surfaces, and current descendant remain observed");
});

test("generated Worker locks global and prototype escape routes before custom code", () => {
  const source = generatedWorkerSource();
  assert.doesNotThrow(() => new vm.Script(source));
  assert.ok(source.indexOf("lockdownWorker(self)") < source.indexOf("loadScript("));
  const { context } = workerContext('return { html: "<p>fixture</p>", css: "" };');
  const access = vm.runInContext(`({
    globalThis: typeof globalThis, self: typeof self, object: typeof Object,
    fetch: typeof self.fetch, inheritedFetch: typeof Object.getPrototypeOf(self).fetch,
    inheritedWebSocket: typeof Object.getPrototypeOf(self).WebSocket,
    inheritedImportScripts: typeof Object.getPrototypeOf(self).importScripts,
    postMessage: typeof self.postMessage, importScripts: typeof self.importScripts,
    worker: typeof self.Worker, sharedWorker: typeof self.SharedWorker, xhr: typeof self.XMLHttpRequest,
    socket: typeof self.WebSocket, eventSource: typeof self.EventSource, webTransport: typeof self.WebTransport,
    rtc: typeof self.RTCPeerConnection, storage: typeof self.localStorage, filePicker: typeof self.showSaveFilePicker,
    blob: typeof self.Blob, url: typeof self.URL, globalConstructor: typeof self.constructor,
    functionGlobal: typeof self.Function, objectConstructorPath: typeof Object.constructor,
    functionConstructor: typeof (function () {}).constructor,
    asyncConstructor: typeof (async function () {}).constructor,
    generatorConstructor: typeof (function* () {}).constructor,
    asyncGeneratorConstructor: typeof (async function* () {}).constructor,
  })`, context) as Record<string, string>;
  assert.equal(access.globalThis, "object");
  assert.equal(access.self, "object");
  assert.equal(access.object, "function");
  for (const [name, value] of Object.entries(access)) {
    if (["globalThis", "self", "object"].includes(name)) continue;
    assert.equal(value, "undefined", `${name} should be blocked`);
  }
  vm.runInContext("self.onmessage({ data: { requestId: 7, notes: [] } }); self.onmessage({ data: { requestId: 8, notes: [] } });", context);
  const messages = context.__messages as Array<{ type: string; requestId: number; html?: string }>;
  assert.equal(messages.length, 1, "a Worker accepts only one render request");
  assert.equal(messages[0]?.type, "result");
  assert.equal(messages[0]?.requestId, 7);
  assert.equal(messages[0]?.html, "<p>fixture</p>");
});

test("sandbox images are limited to note-scoped same-origin asset routes", () => {
  assert.match(runnerSource, /function buildAllowedImageSources\(notes\)/u);
  assert.match(runnerSource, /sources\.add\(`\/api\/views\/assets\/\$\{note\.id\}\?field=poster&v=\$\{note\.contentHash\}`\)/u);
  assert.match(runnerSource, /allowedImageSources\.has\(attribute\.value\)/u);
  assert.match(runnerSource, /url\.origin === "https:\/\/image\.tmdb\.org"/u);
  assert.match(runnerSource, /MAX_ASSET_SOURCES = 50/u);
  assert.doesNotMatch(runnerHtml, /img-src 'none'/u);
  assert.match(apiSource, /img-src 'self'/u);
  assert.match(assetSource, /redirect: "manual"/u);
  assert.match(apiSource, /Content-Length/u);
});

test("generated Worker rejects excessive HTML and CSS before posting output", () => {
  for (const renderSource of [
    'return { html: "x".repeat(48_001), css: "" };',
    'return { html: "<p>ok</p>", css: "x".repeat(12_001) };',
  ]) {
    const { context } = workerContext(renderSource);
    vm.runInContext("self.onmessage({ data: { requestId: 9, notes: [] } })", context);
    const messages = context.__messages as Array<{ type: string; message?: string }>;
    assert.equal(messages[0]?.type, "error");
    assert.equal(messages[0]?.message, "Visualization output exceeded its size limit.");
  }
});

test("synthetic custom-view examples follow the render-function-body contract and produce HTML", () => {
  const examples = [
    ["articles-dashboard.md", "Continue writing"],
    ["babies-dashboard.md", "Add milestone"],
    ["goals-dashboard.md", "Add goal"],
    ["movies-dashboard.md", "Search TMDb"],
  ] as const;
  const input = {
    requestId: 11,
    notes: [{ id: "11111111-1111-4111-8111-111111111111", title: "Synthetic example note", frontmatter: { type: "goal", status: "active" } }],
    trash: [{ id: "22222222-2222-4222-8222-222222222222", title: "Archived synthetic goal", version: 1, folderId: null, trashedAt: "2026-10-12T00:00:00.000Z", excerpt: "" }],
    state: {},
  };

  for (const [filename, expectedContent] of examples) {
    const markdown = readFileSync(path.join(projectRoot, "test/fixtures/native-visualizations", filename), "utf8");
    const block = [...markdown.matchAll(/```fieldnotes-view\n[\s\S]*?\n```/gu)]
      .map((match) => match[0] ?? "")
      .find((candidate) => parseFieldnotesViewConfig(candidate).view === "custom");
    assert.ok(block, `${filename} should contain a view block`);
    const config = parseFieldnotesViewConfig(block);
    assert.equal(config.view, "custom");
    assert.ok(config.js);
    assert.doesNotMatch(config.js, /^\s*function fieldnotesRender\b/u, `${filename} must store a function body, not a nested declaration`);

    const { context } = workerContext(config.js);
    vm.runInContext(`self.onmessage({ data: ${JSON.stringify(input)} });`, context);
    const message = (context.__messages as Array<{ type: string; html?: string; message?: string }>)[0];
    assert.equal(message?.type, "result", `${filename}: ${message?.message ?? "render did not return a result"}`);
    assert.ok(message?.html?.includes(expectedContent), `${filename} should render its expected controls`);
    if (filename === "goals-dashboard.md") assert.match(message?.html ?? "", /aria-label="New goal title"/u);
  }
});

test("synthetic calendar runner output keeps all 31 dates inside the grid and summary outside", () => {
  const renderCalendar = (quoteLiteral: string) => {
    const source = `
      const days = Array.from({ length: 31 }, (_, index) => '<div class="day' + ${quoteLiteral} + (index + 1) + '</div>').join("");
      return { html: '<section><div class="calendar">' + days + '</div><p class="summary">Synthetic summary</p></section>', css: "" };
    `;
    const { context } = workerContext(source);
    vm.runInContext('self.onmessage({ data: { requestId: 31, notes: [], state: {}, trash: [] } });', context);
    const message = (context.__messages as Array<{ type: string; html?: string; message?: string }>)[0];
    assert.equal(message?.type, "result", message?.message);
    return message.html ?? "";
  };
  const malformed = renderCalendar('"' + ">" + '"');
  const corrected = renderCalendar(String.fromCharCode(39, 34, 62, 39));

  assert.match(malformed, /<div class="day>1<\/div>/u, "the regression fixture reproduces the missing class quote");
  const dateLabels = [...corrected.matchAll(/<div class="day">(\d+)<\/div>/gu)].map((match) => Number(match[1]));
  assert.deepEqual(dateLabels, Array.from({ length: 31 }, (_, index) => index + 1));
  const summaryStart = corrected.indexOf('<p class="summary">');
  const gridEnd = corrected.lastIndexOf("</div>", summaryStart) + "</div>".length;
  assert.ok(gridEnd > 0 && summaryStart >= gridEnd, "the summary follows the calendar grid as a sibling");
  assert.doesNotMatch(corrected.slice(0, gridEnd), /class="summary"/u);
});

test("full-size synthetic movie dashboard fits host, worker, asset, and sanitizer limits", () => {
  const records = Array.from({ length: 41 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    title: `Synthetic record ${index + 1}`,
    path: `movies/records/record-${index + 1}.md`,
    contentHash: "a".repeat(64),
    assetPaths: [`movies/posters/record-${index + 1}.jpg`],
    frontmatter: {
      fixture: "movie-dashboard-synthetic",
      kind: "record",
      year: 2024,
      rating: 7.4,
      status: "watched",
      tags: ["synthetic", "catalog"],
    },
  }));
  const watchlist = Array.from({ length: 2 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 42).padStart(12, "0")}`,
    title: `Synthetic watchlist ${index + 1}`,
    path: `movies/watchlist/watch-${index + 1}.md`,
    contentHash: "b".repeat(64),
    assetPaths: [`movies/posters/watch-${index + 1}.jpg`],
    frontmatter: {
      fixture: "movie-dashboard-synthetic",
      kind: "watchlist",
      year: 2025,
      status: "planned",
      tags: ["synthetic", "watchlist"],
    },
  }));
  const notes = [...records, ...watchlist, {
    id: "00000000-0000-4000-8000-000000000044",
    title: "Synthetic dashboard",
    path: "movies/dashboard.md",
    contentHash: "c".repeat(64),
    frontmatter: {
      fixture: "movie-dashboard-synthetic",
      kind: "dashboard",
      month: "2025-01",
      tags: ["synthetic", "dashboard"],
    },
  }];
  const renderSource = `
    const records = notes.filter((note) => note.path.includes("/records/"));
    const watchlist = notes.filter((note) => note.path.includes("/watchlist/"));
    const imageFor = (note) => '<img src="/api/views/assets/' + note.id + '?asset=' + encodeURIComponent(note.assetPaths[0]) + '&v=' + note.contentHash + '" alt="Synthetic poster">';
    const headers = Array.from({ length: 12 }, (_, index) => '<th scope="col">Column ' + (index + 1) + '</th>').join("");
    const rows = records.map((note) => '<tr>' + Array.from({ length: 12 }, (_, index) => '<td>' + (index === 0 ? imageFor(note) : escapeHtml(note.title)) + '</td>').join("") + '</tr>').join("");
    const weekdays = Array.from({ length: 7 }, (_, index) => '<span>Weekday ' + (index + 1) + '</span>').join("");
    const calendar = Array.from({ length: 31 }, (_, index) => '<div class="day">' + (index + 1) + (records[index] ? imageFor(records[index]) : "") + '</div>').join("");
    const stats = Array.from({ length: 12 }, (_, index) => '<div class="stat"><strong>Stat ' + (index + 1) + '</strong><span>Value</span></div>').join("");
    const cards = watchlist.map((note) => '<article>' + imageFor(note) + '<h3>' + escapeHtml(note.title) + '</h3><p>Synthetic</p></article>').join("");
    const html = '<section class="dash"><section class="catalog"><h2>Synthetic catalog</h2><div class="table-wrap"><table><thead><tr>' + headers + '</tr></thead><tbody>' + rows + '</tbody></table></div></section><section class="calendar-panel"><div class="calendar">' + weekdays + calendar + '</div></section><section class="stats">' + stats + '</section><section class="watchlist">' + cards + '</section></section>';
    return { html, css: "" };
  `;
  const input = { requestId: 44, notes, trash: [], state: {} };
  const serializedInput = JSON.stringify(input);
  assert.equal(notes.length, 44);
  assert.equal(records.length, 41);
  assert.equal(watchlist.length, 2);
  assert.ok(notes.length <= 200, "the fixture fits the runner note cap");
  assert.ok(serializedInput.length < 1_000_000, "the fixture fits the runner input cap");

  const { context } = workerContext(renderSource);
  vm.runInContext(`self.onmessage({ data: ${serializedInput} });`, context);
  const result = (context.__messages as Array<{ type: string; html?: string; message?: string }>)[0];
  assert.equal(result?.type, "result", result?.message);
  const html = result?.html ?? "";
  assert.ok(html.length < 48_000, "the fixture fits the runner HTML byte cap");
  const parsedHtml = parseSyntheticMarkup(html);
  const elementCount = parsedHtml.reduce((count, node) => count + countSyntheticDomElements(node), 0);
  assert.equal(elementCount, 711, "the fixture covers 41 twelve-column records, calendar, stats, and watchlist");
  assert.equal(parsedHtml.reduce((count, node) => count + countSyntheticDomElementsNamed(node, "img"), 0), 74,
    "the fixture renders 41 catalog, 31 calendar, and 2 watchlist poster instances");
  assert.ok(elementCount > 500, `fixture should reproduce the former cap, got ${elementCount} elements`);
  assert.ok(elementCount <= 1_000, `fixture should remain inside the bounded sanitizer cap, got ${elementCount} elements`);
  assert.doesNotMatch(html, /\?field=poster/u, "local poster files must use the host's asset query shape");

  const sanitizer = sanitizerContext();
  sanitizer.__fixtureHtml = html;
  sanitizer.__fixtureNotes = notes;
  const allowedImageSources = vm.runInContext("buildAllowedImageSources(__fixtureNotes)", sanitizer) as Set<string>;
  assert.equal(allowedImageSources.size, 43, "the actual runner builder derives one local asset URL per image note");
  assert.ok(allowedImageSources.size <= 50, "the actual builder stays within the allowed asset-source cap");
  sanitizer.__allowedImageSources = allowedImageSources;
  const sanitized = vm.runInContext("sanitizeMarkup(__fixtureHtml, __allowedImageSources)", sanitizer) as SyntheticDomNode;
  assert.equal(countSyntheticDomElements(sanitized), elementCount, "all fixture elements remain within the sanitizer policy");
  assert.equal(countSyntheticDomElementsNamed(sanitized, "img"), 74, "all local poster instances survive the real allowlist and sanitizer");

  sanitizer.__fixtureHtml = Array.from({ length: 1_001 }, () => "<div></div>").join("");
  let boundedRejection = "";
  try {
    vm.runInContext("sanitizeMarkup(__fixtureHtml, new Set())", sanitizer);
  } catch (error) {
    boundedRejection = String(error);
  }
  assert.match(boundedRejection, /HTML output has too many elements/u, "the sanitizer must keep a hard element ceiling");
});

test("vault overview example renders a synthetic read-only dashboard with local filters", () => {
  const examplePath = path.join(projectRoot, "packages/markdown-live-editor/examples/vault-overview-dashboard.md");
  const markdown = readFileSync(examplePath, "utf8");
  const fence = markdown.match(/```fieldnotes-view\n([\s\S]*?)\n```/u)?.[0];
  assert.ok(fence, "dashboard example should contain one Fieldnotes view block");
  const config = parseFieldnotesViewConfig(fence);
  assert.equal(config.view, "custom");
  assert.deepEqual(config.query?.where, [{ field: "frontmatter.demo", operator: "eq", value: true }]);
  assert.ok(config.js);
  const notes = [
    { id: "00000000-0000-4000-8000-000000000001", title: "House Budget", path: "Sample/House Budget.md", updatedAt: new Date().toISOString(), frontmatter: { demo: true, status: "active" } },
    { id: "00000000-0000-4000-8000-000000000002", title: "Reading queue", path: "Sample/Reading queue.md", updatedAt: new Date().toISOString(), frontmatter: { demo: true, status: "draft" } },
  ];
  const input = { requestId: 1, notes, trash: [], state: { status: "all", search: "" } };
  const { context } = workerContext(config.js);
  vm.runInContext(`self.onmessage({ data: ${JSON.stringify(input)} });`, context);
  const message = (context.__messages as Array<{ type: string; html?: string; message?: string }>)[0];
  assert.equal(message?.type, "result", message?.message);
  assert.match(message?.html ?? "", /Vault overview/u);
  assert.match(message?.html ?? "", /House Budget/u);
  assert.match(message?.html ?? "", /2 of 2 matching demo notes/u);
  assert.deepEqual([...config.js.matchAll(/data-fn-event="([^"]+)"/gu)].map((match) => match[1]), ["state.set", "state.set"]);

  const filtered = workerContext(config.js);
  vm.runInContext(`self.onmessage({ data: ${JSON.stringify({ ...input, state: { status: "active", search: "budget" } })} });`, filtered.context);
  const filteredMessage = (filtered.context.__messages as Array<{ type: string; html?: string }>)[0];
  assert.equal(filteredMessage?.type, "result");
  assert.match(filteredMessage?.html ?? "", /House Budget/u);
  assert.doesNotMatch(filteredMessage?.html ?? "", /Reading queue/u);
});

test("runner source masks network APIs and drops outbound HTML/CSS surfaces", () => {
  for (const api of [
    '"fetch"', '"XMLHttpRequest"', '"WebSocket"', '"EventSource"', '"WebTransport"',
    '"RTCPeerConnection"', '"Worker"', '"SharedWorker"', '"importScripts"', '"indexedDB"',
    '"localStorage"', '"showSaveFilePicker"', '"OffscreenCanvas"', '"constructor"',
  ]) assert.ok(runnerSource.includes(api), `missing blocked API ${api}`);
  assert.match(runnerSource, /const MAX_EXECUTION_MS = 700/);
  assert.match(runnerSource, /const MAX_NOTES = 200/);
  assert.match(runnerSource, /const MAX_INPUT_CHARS = 1_000_000/);
  assert.match(runnerSource, /const MAX_JAVASCRIPT_CHARS = 16_000/);
  assert.match(runnerSource, /const MAX_HTML_CHARS = 48_000/);
  assert.match(runnerSource, /const MAX_CSS_CHARS = 12_000/);
  assert.match(runnerSource, /const MAX_ELEMENTS = 1_000/);
  assert.match(runnerSource, /const MAX_DEPTH = 20/);
  assert.match(runnerSource, /const ALLOWED_TAGS = new Set\(\[.*"form".*"input"/s);
  assert.match(runnerSource, /const DROPPED_TAGS = new Set\(\[.*"script".*"iframe".*"object"/s);
  assert.match(runnerSource, /const ALLOWED_TAGS = new Set\(\[.*"img"/s);
  assert.match(runnerSource, /url\\s\*\\\(/);
  assert.match(runnerSource, /@import/);
  const allowedAttributes = runnerSource.match(/const ALLOWED_ATTRIBUTES = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  assert.match(allowedAttributes, /"src"/);
  assert.doesNotMatch(allowedAttributes, /\b(?:href|action|formaction)\b/);
  assert.match(runnerSource, /attributeName === "src" && \(name !== "img" \|\| !allowedImageSources\.has\(attribute\.value\)\)/);
  assert.equal(runnerSource.match(/if \(!event\.isTrusted\) return;/gu)?.length, 3, "click, submit, and change actions require trusted input");
  assert.match(runnerSource, /event\.source !== window\.parent/);
  assert.match(runnerSource, /event\.origin !== expectedParentOrigin/);
  assert.match(runnerSource, /activeRequestId !== message\.requestId/);
  assert.match(runnerSource, /if \(!event\.isTrusted\) return/u);
  assert.match(runnerSource, /const ALLOWED_EVENTS = new Set\(\[/u);
  assert.match(runnerSource, /event\.data\?\.type !== "fieldnotes-view-connect"/u);
});

test("custom view execution requires local approval for the exact note, block, and source fingerprint", () => {
  assert.match(adaptersSource, /fieldnotes:trusted-view:v1:/u);
  assert.match(adaptersSource, /isVisualizationTrusted\(documentId: string, blockIndex: number, sourceHash: string\)/u);
  assert.match(adaptersSource, /enableCustomVisualizations: true/u);
  assert.match(viewBlockSource, /sourceDigest\(raw\)/u);
  assert.match(viewBlockSource, /options\.visualizationTrustAdapter\.isTrusted\(documentId, blockIndex, sourceHash\)/u);
  assert.match(viewBlockSource, /Trust this source and run/u);
  assert.match(viewBlockSource, /Revoke trust/u);
  assert.match(viewBlockSource, /trusted && !error && result/u);

  const trustedOutputStart = viewBlockSource.indexOf('parsed.config?.view === "custom" && options.enableCustomVisualizations && trusted && !error && result && (');
  const trustedOutputEnd = viewBlockSource.indexOf('parsed.config?.view === "custom" && options.enableCustomVisualizations && !error && !result && (', trustedOutputStart);
  assert.ok(trustedOutputStart >= 0 && trustedOutputEnd > trustedOutputStart);
  const trustedOutput = viewBlockSource.slice(trustedOutputStart, trustedOutputEnd);
  assert.match(trustedOutput, /<SandboxedVisualization/u);
  assert.match(trustedOutput, /Revoke trust/u);
  assert.doesNotMatch(trustedOutput, />\s*Run script\s*</u);
});

test("changing notes and view inputs cancels stale work and releases runner resources", () => {
  assert.match(viewBlockSource, /generation === requestGenerationRef\.current/u);
  assert.match(viewBlockSource, /currentControllerRef\.current\?\.abort\(\)/u);
  assert.match(appSource, /key=\{displayDocument\.id\}/u);
  assert.match(editorSource, /portRef\.current\?\.postMessage\(\{ type: "cancel"/u);
  assert.match(editorSource, /portRef\.current\?\.close\(\)/u);
  assert.match(runnerSource, /worker\.terminate\(\)/u);
  assert.match(runnerSource, /\}, MAX_EXECUTION_MS\)/u);
});
