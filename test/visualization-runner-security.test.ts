import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerSource = readFileSync(path.join(projectRoot, "public/visualization-runner.js"), "utf8");
const runnerHtml = readFileSync(path.join(projectRoot, "public/visualization-runner.html"), "utf8");
const apiSource = readFileSync(path.join(projectRoot, "server/api.ts"), "utf8");
const editorSource = readFileSync(path.join(projectRoot, "packages/markdown-live-editor/SandboxedVisualization.tsx"), "utf8");
const runnerScriptHash = `sha256-${createHash("sha256").update(runnerSource).digest("base64")}`;

function generatedWorkerSource(javascript = 'return { html: "<p>fixture</p>", css: "" };'): string {
  const context = vm.createContext({
    URLSearchParams,
    window: { location: { search: "" }, parent: {}, addEventListener: () => undefined },
    document: { getElementById: () => ({ textContent: "", replaceChildren: () => undefined }) },
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
      self.fieldnotesRender = function() { ${renderSource} };
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
    for (const directive of ["connect-src 'none'", "img-src 'none'", "font-src 'none'", "media-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src blob:"]) {
      assert.ok(policy.includes(directive), `missing CSP directive ${directive}`);
    }
    assert.doesNotMatch(policy, /unsafe-eval/);
  }
  assert.match(header, /frame-ancestors 'self'/);
  assert.match(editorSource, /sandbox="allow-scripts"/);
  assert.match(editorSource, /referrerPolicy="no-referrer"/i);
  assert.ok(runnerHtml.includes(`integrity="${runnerScriptHash}"`));
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

test("runner source masks network APIs and drops outbound HTML/CSS surfaces", () => {
  for (const api of [
    '"fetch"', '"XMLHttpRequest"', '"WebSocket"', '"EventSource"', '"WebTransport"',
    '"RTCPeerConnection"', '"Worker"', '"SharedWorker"', '"importScripts"', '"indexedDB"',
    '"localStorage"', '"showSaveFilePicker"', '"OffscreenCanvas"', '"constructor"',
  ]) assert.ok(runnerSource.includes(api), `missing blocked API ${api}`);
  assert.match(runnerSource, /const MAX_EXECUTION_MS = 700/);
  assert.match(runnerSource, /const MAX_NOTES = 200/);
  assert.match(runnerSource, /const MAX_INPUT_CHARS = 1_000_000/);
  assert.match(runnerSource, /const MAX_HTML_CHARS = 48_000/);
  assert.match(runnerSource, /const MAX_CSS_CHARS = 12_000/);
  assert.match(runnerSource, /const MAX_ELEMENTS = 500/);
  assert.match(runnerSource, /const MAX_DEPTH = 20/);
  assert.match(runnerSource, /const DROPPED_TAGS = new Set\(\[.*"iframe".*"img".*"form"/s);
  assert.match(runnerSource, /url\\s\*\\\(/);
  assert.match(runnerSource, /@import/);
  assert.doesNotMatch(runnerSource, /ALLOWED_ATTRIBUTES = new Set\(\[[^\]]*\b(?:href|src|action|formaction)\b/);
  assert.match(runnerSource, /event\.source !== window\.parent/);
  assert.match(runnerSource, /event\.origin !== expectedParentOrigin/);
  assert.match(runnerSource, /activeRequestId !== message\.requestId/);
});
