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
const adaptersSource = readFileSync(path.join(projectRoot, "src/editor-adapters.ts"), "utf8");
const frameHeightSource = readFileSync(path.join(projectRoot, "packages/markdown-live-editor/visualization-frame-height.ts"), "utf8");
const appSource = readFileSync(path.join(projectRoot, "src/App.tsx"), "utf8");
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
  assert.match(runnerSource, /const MAX_ELEMENTS = 500/);
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
