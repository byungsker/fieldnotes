const MAX_EXECUTION_MS = 700;
const MAX_HTML_CHARS = 48_000;
const MAX_CSS_CHARS = 12_000;
const MAX_NOTES = 200;
const MAX_INPUT_CHARS = 1_000_000;
const MAX_ELEMENTS = 500;
const MAX_DEPTH = 20;
const ALLOWED_TAGS = new Set([
  "div", "section", "article", "header", "footer", "h1", "h2", "h3", "h4", "p", "span",
  "strong", "em", "small", "code", "pre", "ul", "ol", "li", "table", "thead", "tbody",
  "tr", "th", "td", "time", "br", "hr", "button",
]);
const DROPPED_TAGS = new Set(["script", "style", "iframe", "img", "svg", "link", "meta", "object", "embed", "form", "input", "video", "audio", "source"]);
const ALLOWED_ATTRIBUTES = new Set(["class", "role", "title", "aria-label", "aria-live", "colspan", "rowspan", "scope"]);
const ALLOWED_PROPERTIES = new Set([
  "color", "background-color", "border", "border-color", "border-radius", "border-width", "border-style", "box-shadow",
  "display", "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-column", "grid-row",
  "align-items", "justify-content", "flex", "flex-wrap", "flex-direction", "padding", "padding-block", "padding-inline",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "margin", "margin-block", "margin-inline", "margin-top",
  "margin-right", "margin-bottom", "margin-left", "font-family", "font-size", "font-weight", "line-height", "text-align",
  "text-decoration", "max-width", "min-width", "width", "min-height", "height", "opacity", "overflow", "white-space",
]);
const root = document.getElementById("root");
const expectedParentOrigin = new URLSearchParams(window.location.search).get("parentOrigin");
let hostPort;
let worker;
let workerUrl;
let workerTimer;
let activeRequestId;

function sendToHost(message) {
  if (hostPort) hostPort.postMessage(message);
}

function stopWorker() {
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = undefined;
  if (worker) worker.terminate();
  worker = undefined;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = undefined;
}

function sanitizeMarkup(markup) {
  if (markup.length > MAX_HTML_CHARS) throw new Error("HTML output is larger than 48 KB.");
  const parsed = new DOMParser().parseFromString(`<root xmlns="http://www.w3.org/1999/xhtml">${markup}</root>`, "application/xhtml+xml");
  if (parsed.querySelector("parsererror")) throw new Error("HTML output must be well-formed XHTML.");
  const output = document.createDocumentFragment();
  let elementCount = 0;
  const copyChildren = (source, destination, depth) => {
    if (depth > MAX_DEPTH) throw new Error("HTML output is nested too deeply.");
    for (const child of source.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        destination.append(document.createTextNode(child.nodeValue || ""));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const name = child.localName.toLowerCase();
      if (DROPPED_TAGS.has(name)) continue;
      if (!ALLOWED_TAGS.has(name)) {
        copyChildren(child, destination, depth + 1);
        continue;
      }
      elementCount += 1;
      if (elementCount > MAX_ELEMENTS) throw new Error("HTML output has too many elements.");
      const element = document.createElement(name);
      for (const attribute of child.attributes) {
        const attributeName = attribute.name.toLowerCase();
        if (!ALLOWED_ATTRIBUTES.has(attributeName)) continue;
        if (attributeName === "class" && !/^[A-Za-z0-9 _-]{0,160}$/.test(attribute.value)) continue;
        if (attributeName.startsWith("aria-") && attribute.value.length > 160) continue;
        if (["colspan", "rowspan"].includes(attributeName) && !/^[1-9]\d?$/.test(attribute.value)) continue;
        element.setAttribute(attributeName, attribute.value);
      }
      destination.append(element);
      if (!["br", "hr"].includes(name)) copyChildren(child, element, depth + 1);
    }
  };
  copyChildren(parsed.documentElement, output, 0);
  return output;
}

function sanitizeStyles(styles) {
  if (styles.length > MAX_CSS_CHARS) throw new Error("CSS output is larger than 12 KB.");
  if (/url\s*\(|@import|@font-face|expression\s*\(|behavior\s*:|-moz-binding|\\|<|>|!important/i.test(styles)) {
    throw new Error("CSS output contains a blocked feature.");
  }
  const safeRules = [];
  for (const rawRule of styles.split("}")) {
    const rule = rawRule.trim();
    if (!rule) continue;
    const brace = rule.indexOf("{");
    if (brace <= 0 || rule.includes("@")) continue;
    const selector = rule.slice(0, brace).trim();
    const selectorPart = "(?:[A-Za-z][A-Za-z0-9-]*|\\.[A-Za-z_][A-Za-z0-9_-]*)";
    if (!new RegExp(`^${selectorPart}(?:\\s+${selectorPart})*$`).test(selector)) continue;
    const declarations = [];
    for (const rawDeclaration of rule.slice(brace + 1).split(";")) {
      const colon = rawDeclaration.indexOf(":");
      if (colon <= 0) continue;
      const property = rawDeclaration.slice(0, colon).trim().toLowerCase();
      const value = rawDeclaration.slice(colon + 1).trim();
      if (!ALLOWED_PROPERTIES.has(property) || !value || value.length > 200 || !/^[A-Za-z0-9\s#(),.%+-]+$/.test(value)) continue;
      declarations.push(`${property}:${value}`);
    }
    if (declarations.length) safeRules.push(`.fieldnotes-custom-root ${selector}{${declarations.join(";")}}`);
    if (safeRules.length > 80) throw new Error("CSS output has too many rules.");
  }
  return safeRules.join("\n");
}

function buildWorkerSource(javascript) {
  return `(() => {
    const nativePost = self.postMessage.bind(self);
    const loadScript = self.importScripts.bind(self);
    const NativeBlob = self.Blob;
    const NativeURL = self.URL;
    lockdownWorker(self);
    const scriptUrl = NativeURL.createObjectURL(new NativeBlob([
      "self.fieldnotesRender = function(notes, escapeHtml) {\\n",
      ${JSON.stringify(javascript)},
      "\\n};",
    ], { type: "text/javascript" }));
    try { loadScript(scriptUrl); }
    finally { NativeURL.revokeObjectURL(scriptUrl); }
    const userRender = self.fieldnotesRender;
    if (typeof userRender !== "function") throw new Error("Define fieldnotesRender(notes, escapeHtml) in the visualization script.");
    let used = false;
    self.onmessage = (event) => {
      if (used) return;
      used = true;
      const input = event.data;
      try {
        const notes = deepFreeze(input.notes);
        const value = userRender(notes, escapeHtml);
        if (!value || typeof value !== "object" || typeof value.html !== "string") throw new Error("Return an object with an html string.");
        const css = value.css === undefined ? "" : value.css;
        if (typeof css !== "string" || value.html.length > ${MAX_HTML_CHARS} || css.length > ${MAX_CSS_CHARS}) throw new Error("Visualization output exceeded its size limit.");
        nativePost({ type: "result", requestId: input.requestId, html: value.html, css });
      } catch (error) {
        nativePost({ type: "error", requestId: input.requestId, message: String(error && error.message || "Script error").slice(0, 240) });
      }
    };
    function deepFreeze(value, seen = new Set()) {
      if (!value || typeof value !== "object" || seen.has(value)) return value;
      seen.add(value);
      for (const child of Object.values(value)) deepFreeze(child, seen);
      return Object.freeze(value);
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
    }
    function lockdownWorker(scope) {
      const blocked = [
        "Worker", "SharedWorker", "importScripts", "postMessage", "fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream",
        "EventSource", "BroadcastChannel", "WebTransport", "RTCPeerConnection", "navigator", "indexedDB", "caches",
        "localStorage", "sessionStorage", "window", "document", "location", "origin", "parent", "top", "opener",
        "Blob", "URL", "File", "FileReader",
        "FileSystemHandle", "FileSystemFileHandle", "FileSystemDirectoryHandle", "showOpenFilePicker", "showSaveFilePicker",
        "OffscreenCanvas", "ImageBitmap", "ImageData", "createImageBitmap", "VideoFrame", "AudioContext", "OfflineAudioContext",
        "WebAssembly", "SharedArrayBuffer", "Atomics", "WorkerGlobalScope", "DedicatedWorkerGlobalScope", "WorkerNavigator",
        "setTimeout", "setInterval", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
        "cancelIdleCallback", "eval", "Function", "constructor",
      ];
      const chain = [];
      for (let current = scope; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) chain.push(current);
      const lockUndefined = (target, name) => {
        const descriptor = Object.getOwnPropertyDescriptor(target, name);
        if (descriptor?.configurable === false) {
          if ("value" in descriptor && descriptor.value === undefined && descriptor.writable === false) return;
          throw new Error("Could not isolate " + name + ".");
        }
        Object.defineProperty(target, name, {
          configurable: false,
          enumerable: descriptor?.enumerable ?? false,
          writable: false,
          value: undefined,
        });
      };
      for (const name of blocked) {
        lockUndefined(scope, name);
        for (const target of chain.slice(1)) {
          if (Object.getOwnPropertyDescriptor(target, name)) lockUndefined(target, name);
        }
      }
      const functionValues = [function empty() {}, async function emptyAsync() {}, function* emptyGenerator() {}, async function* emptyAsyncGenerator() {}];
      for (const value of functionValues) lockUndefined(Object.getPrototypeOf(value), "constructor");
    }
  })();`;
}

function renderResult(message) {
  if (message.type === "error") {
    root.textContent = message.message || "Visualization script failed.";
    sendToHost({ type: "error", requestId: message.requestId, message: root.textContent });
    return;
  }
  if (typeof message.html !== "string" || typeof message.css !== "string"
    || message.html.length > MAX_HTML_CHARS || message.css.length > MAX_CSS_CHARS) {
    root.textContent = "Visualization output exceeded its size limit.";
    sendToHost({ type: "error", requestId: message.requestId, message: root.textContent });
    return;
  }
  try {
    const content = sanitizeMarkup(message.html);
    const stylesheet = sanitizeStyles(message.css);
    const container = document.createElement("div");
    container.className = "fieldnotes-custom-root";
    container.append(content);
    root.replaceChildren(container);
    const existing = document.getElementById("user-styles");
    if (existing) existing.remove();
    if (stylesheet) {
      const style = document.createElement("style");
      style.id = "user-styles";
      style.textContent = stylesheet;
      document.head.append(style);
    }
    sendToHost({ type: "complete", requestId: message.requestId });
  } catch (error) {
    root.textContent = error instanceof Error ? error.message : "Visualization output was blocked.";
    sendToHost({ type: "error", requestId: message.requestId, message: root.textContent });
  }
}

function runVisualization(message) {
  stopWorker();
  activeRequestId = message.requestId;
  root.textContent = "Running visualization…";
  if (!Array.isArray(message.notes) || message.notes.length > MAX_NOTES || typeof message.javascript !== "string" || message.javascript.length > 12_000) {
    root.textContent = "Visualization input exceeded its size limit.";
    sendToHost({ type: "error", requestId: message.requestId, message: root.textContent });
    return;
  }
  const serialized = JSON.stringify(message.notes);
  if (serialized.length > MAX_INPUT_CHARS) {
    root.textContent = "Visualization input is larger than 1 MB.";
    sendToHost({ type: "error", requestId: message.requestId, message: root.textContent });
    return;
  }
  workerUrl = URL.createObjectURL(new Blob([buildWorkerSource(message.javascript)], { type: "text/javascript" }));
  worker = new Worker(workerUrl);
  worker.onerror = (event) => {
    event.preventDefault();
    if (activeRequestId !== message.requestId) return;
    stopWorker();
    root.textContent = "Visualization script failed to start.";
    sendToHost({ type: "error", requestId: message.requestId, message: root.textContent });
  };
  worker.onmessage = (event) => {
    if (activeRequestId !== message.requestId || event.data?.requestId !== message.requestId) return;
    stopWorker();
    renderResult(event.data);
  };
  worker.postMessage({ requestId: message.requestId, notes: message.notes });
  workerTimer = setTimeout(() => {
    if (activeRequestId !== message.requestId) return;
    stopWorker();
    root.textContent = "Visualization stopped after 700 ms.";
    sendToHost({ type: "timeout", requestId: message.requestId });
  }, MAX_EXECUTION_MS);
}

function connect(event) {
  if (event.source !== window.parent || event.origin !== expectedParentOrigin) return;
  if (event.data?.type === "fieldnotes-view-ping") {
    window.parent.postMessage({ type: "fieldnotes-view-runner-ready" }, "*");
    return;
  }
  if (event.data?.type !== "fieldnotes-view-connect" || !event.ports[0]) return;
  window.removeEventListener("message", connect);
  hostPort = event.ports[0];
  hostPort.onmessage = (portEvent) => {
    const message = portEvent.data;
    if (message?.type === "cancel" && (message.requestId === undefined || message.requestId === activeRequestId)) {
      stopWorker();
      activeRequestId = undefined;
      root.textContent = "Waiting for the Fieldnotes host…";
      return;
    }
    if (message?.type === "run" && Number.isSafeInteger(message.requestId)) runVisualization(message);
  };
  hostPort.start();
  sendToHost({ type: "ready" });
}

window.addEventListener("message", connect);
