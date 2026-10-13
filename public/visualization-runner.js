const MAX_EXECUTION_MS = 700;
const MAX_HTML_CHARS = 48_000;
const MAX_CSS_CHARS = 12_000;
const MAX_NOTES = 200;
const MAX_TRASH = 100;
const MAX_INPUT_CHARS = 1_000_000;
const MAX_JAVASCRIPT_CHARS = 16_000;
const MAX_ELEMENTS = 500;
const MAX_DEPTH = 20;
const MAX_ASSET_SOURCES = 50;
const MIN_FRAME_HEIGHT = 160;
const MAX_FRAME_HEIGHT = 16_000;
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTE_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const ALLOWED_TAGS = new Set([
  "div", "section", "article", "header", "footer", "h1", "h2", "h3", "h4", "p", "span",
  "strong", "em", "small", "code", "pre", "ul", "ol", "li", "table", "thead", "tbody", "img",
  "tr", "th", "td", "time", "br", "hr", "button", "form", "label", "input", "textarea", "select", "option",
]);
const DROPPED_TAGS = new Set(["script", "style", "iframe", "svg", "link", "meta", "object", "embed", "video", "audio", "source"]);
const ALLOWED_ATTRIBUTES = new Set([
  "class", "role", "title", "aria-label", "aria-live", "colspan", "rowspan", "scope", "type", "name", "value",
  "placeholder", "checked", "selected", "disabled", "required", "min", "max", "step", "for", "rows",
  "data-fn-event", "data-note-id", "data-state-key", "data-state-value", "src", "alt", "width", "height",
]);
const ALLOWED_PROPERTIES = new Set([
  "color", "background-color", "border", "border-color", "border-radius", "border-width", "border-style", "box-shadow",
  "display", "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-column", "grid-row",
  "align-items", "justify-content", "flex", "flex-wrap", "flex-direction", "padding", "padding-block", "padding-inline",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "margin", "margin-block", "margin-inline", "margin-top",
  "margin-right", "margin-bottom", "margin-left", "font-family", "font-size", "font-weight", "line-height", "text-align", "object-fit",
  "text-decoration", "max-width", "min-width", "width", "min-height", "height", "opacity", "overflow", "white-space",
]);
const root = document.getElementById("root");
const expectedParentOrigin = new URLSearchParams(window.location.search).get("parentOrigin");
let hostPort;
let worker;
let workerUrl;
let workerTimer;
let activeRequestId;
let nextEventId = 1;
let pendingEventId;
let actionLocked = false;
let resizeFrameScheduled = false;

function sendToHost(message) {
  if (hostPort) hostPort.postMessage(message);
}

function reportFrameHeight() {
  resizeFrameScheduled = false;
  if (!Number.isSafeInteger(activeRequestId)) return;
  let height = Math.max(
    root.scrollHeight,
    document.body.scrollHeight,
    document.documentElement.scrollHeight,
  );
  const rootBounds = root.getBoundingClientRect();
  for (const element of root.querySelectorAll("*")) {
    const style = window.getComputedStyle(element);
    if (!/(?:auto|scroll)/.test(style.overflowY || style.overflow || "")) continue;
    const bounds = element.getBoundingClientRect();
    const hiddenContent = Math.max(0, element.scrollHeight - element.clientHeight);
    height = Math.max(height, bounds.bottom - rootBounds.top + hiddenContent);
  }
  height = Math.ceil(height);
  sendToHost({
    type: "resize",
    requestId: activeRequestId,
    height: Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, height)),
  });
}

function scheduleFrameHeightReport() {
  if (resizeFrameScheduled) return;
  resizeFrameScheduled = true;
  requestAnimationFrame(reportFrameHeight);
}

const frameResizeObserver = typeof ResizeObserver === "function"
  ? new ResizeObserver(scheduleFrameHeightReport)
  : undefined;

function observeFrameContent() {
  if (!frameResizeObserver) return;
  frameResizeObserver.observe(root);
  frameResizeObserver.observe(document.body);
  frameResizeObserver.observe(document.documentElement);
  for (const element of root.querySelectorAll("*")) frameResizeObserver.observe(element);
}

observeFrameContent();

if (typeof MutationObserver === "function") {
  const frameMutationObserver = new MutationObserver(() => {
    observeFrameContent();
    scheduleFrameHeightReport();
  });
  frameMutationObserver.observe(root, { childList: true, subtree: true, characterData: true });
  frameMutationObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
}

root.addEventListener("load", scheduleFrameHeightReport, true);
window.addEventListener("resize", scheduleFrameHeightReport);
window.visualViewport?.addEventListener("resize", scheduleFrameHeightReport);

function stopWorker() {
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = undefined;
  if (worker) worker.terminate();
  worker = undefined;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = undefined;
}

function sanitizeMarkup(markup, allowedImageSources = new Set()) {
  if (markup.length > MAX_HTML_CHARS) throw new Error("HTML output is larger than 48 KB.");
  const parsed = new DOMParser().parseFromString(markup, "text/html");
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
      if (name === "img" && ![...child.attributes].some((attribute) => attribute.name.toLowerCase() === "src" && allowedImageSources.has(attribute.value))) continue;
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
        if (attributeName === "src" && (name !== "img" || !allowedImageSources.has(attribute.value))) continue;
        if (attributeName === "class" && !/^[A-Za-z0-9 _-]{0,160}$/.test(attribute.value)) continue;
        if (attributeName.startsWith("aria-") && attribute.value.length > 160) continue;
        if (["colspan", "rowspan"].includes(attributeName) && !/^[1-9]\d?$/.test(attribute.value)) continue;
        if (["width", "height"].includes(attributeName) && (!/^[1-9]\d{0,3}$/.test(attribute.value) || Number(attribute.value) > 2_048)) continue;
        if (attributeName === "alt" && attribute.value.length > 500) continue;
        if (attributeName === "type" && name === "input" && !["text", "search", "number", "date", "checkbox", "hidden"].includes(attribute.value.toLowerCase())) continue;
        if (attributeName === "name" && !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(attribute.value)) continue;
        if (["data-note-id"].includes(attributeName) && !/^[0-9a-f-]{36}$/i.test(attribute.value)) continue;
        if (attributeName === "data-state-key" && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(attribute.value)) continue;
        if (attributeName === "data-fn-event" && !ALLOWED_EVENTS.has(attribute.value)) continue;
        if (["value", "placeholder", "data-state-value", "title"].includes(attributeName) && attribute.value.length > 2_000) continue;
        if (attributeName === "for" && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(attribute.value)) continue;
        if (["min", "max", "step", "rows"].includes(attributeName) && !/^-?\d{1,8}(?:\.\d{1,4})?$/.test(attribute.value)) continue;
        if (["checked", "selected", "disabled", "required"].includes(attributeName) && !["", name, attributeName].includes(attribute.value.toLowerCase())) continue;
        element.setAttribute(attributeName, attribute.value);
      }
      destination.append(element);
      if (!["br", "hr", "img"].includes(name)) copyChildren(child, element, depth + 1);
    }
  };
  copyChildren(parsed.body, output, 0);
  return output;
}

const ALLOWED_EVENTS = new Set([
  "state.set", "state.toggle", "note.open", "note.create", "note.update", "note.frontmatter.patch",
  "note.trash", "trash.restore", "movies.search",
]);

function readEventFields(form) {
  const fields = {};
  if (!form) return fields;
  for (const control of form.elements) {
    if (!control.name || control.disabled || control.type === "file" || control.type === "password") continue;
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(control.name) || Object.hasOwn(fields, control.name)) continue;
    const value = control.type === "checkbox" ? String(control.checked) : String(control.value ?? "");
    if (value.length > 4_000 || Object.keys(fields).length >= 32) throw new Error("Action form exceeds its field limit.");
    fields[control.name] = value;
  }
  return fields;
}

function emitUiEvent(target) {
  const actionNode = target?.closest?.("[data-fn-event]");
  if (!actionNode || pendingEventId !== undefined || actionLocked) return;
  const type = actionNode.getAttribute("data-fn-event");
  if (!ALLOWED_EVENTS.has(type)) return;
  const noteId = actionNode.getAttribute("data-note-id") || "";
  let uiEvent;
  if (type === "state.toggle") {
    uiEvent = { type, key: actionNode.getAttribute("data-state-key") || "" };
  } else if (type === "state.set") {
    const rawValue = actionNode.getAttribute("data-state-value");
    let value = actionNode instanceof HTMLInputElement && actionNode.type === "checkbox"
      ? actionNode.checked
      : actionNode.value !== undefined && rawValue === null ? actionNode.value : rawValue;
    try { if (typeof value === "string") value = JSON.parse(value); } catch { /* plain text is also a supported state value */ }
    uiEvent = { type, key: actionNode.getAttribute("data-state-key") || "", value };
  } else if (type === "note.create" || type === "movies.search") {
    uiEvent = { type, fields: readEventFields(actionNode.closest("form")) };
  } else if (type === "note.update" || type === "note.frontmatter.patch") {
    uiEvent = { type, noteId, fields: readEventFields(actionNode.closest("form")) };
  } else {
    uiEvent = { type, noteId };
  }
  const eventId = nextEventId++;
  pendingEventId = eventId;
  actionLocked = true;
  root.dataset.actionPending = "true";
  sendToHost({ type: "action", requestId: activeRequestId, eventId, event: uiEvent });
}

root.addEventListener("click", (event) => {
  if (!event.isTrusted) return;
  const node = event.target instanceof Element ? event.target.closest("[data-fn-event]") : null;
  if (node?.tagName === "BUTTON" && !node.closest("form")) {
    event.preventDefault();
    emitUiEvent(node);
  }
});
root.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!event.isTrusted) return;
  const submitter = event.submitter;
  const form = event.target;
  const node = submitter instanceof Element && submitter.hasAttribute("data-fn-event") ? submitter : form;
  emitUiEvent(node);
});
root.addEventListener("change", (event) => {
  if (!event.isTrusted) return;
  const node = event.target instanceof Element ? event.target.closest("[data-fn-event]") : null;
  if (["state.set", "state.toggle"].includes(node?.getAttribute("data-fn-event") || "")) emitUiEvent(node);
});

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
      "self.fieldnotesRender = function(notes, escapeHtml, state, trash) {\\n",
      ${JSON.stringify(javascript)},
      "\\n};",
    ], { type: "text/javascript" }));
    try { loadScript(scriptUrl); }
    finally { NativeURL.revokeObjectURL(scriptUrl); }
    const userRender = self.fieldnotesRender;
    if (typeof userRender !== "function") throw new Error("Define fieldnotesRender(notes, escapeHtml, state, trash) in the visualization script.");
    let used = false;
    self.onmessage = (event) => {
      if (used) return;
      used = true;
      const input = event.data;
      try {
        const notes = deepFreeze(input.notes);
        const trash = deepFreeze(input.trash);
        const state = deepFreeze(input.state);
        const value = userRender(notes, escapeHtml, state, trash);
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

function renderResult(message, allowedImageSources) {
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
    const content = sanitizeMarkup(message.html, allowedImageSources);
    const stylesheet = sanitizeStyles(message.css);
    const container = document.createElement("div");
    container.className = "fieldnotes-custom-root";
    container.append(content);
    root.replaceChildren(container);
    observeFrameContent();
    const existing = document.getElementById("user-styles");
    if (existing) existing.remove();
    if (stylesheet) {
      const style = document.createElement("style");
      style.id = "user-styles";
      style.textContent = stylesheet;
      document.head.append(style);
    }
    sendToHost({ type: "complete", requestId: message.requestId });
    reportFrameHeight();
    scheduleFrameHeightReport();
  } catch (error) {
    root.textContent = error instanceof Error ? error.message : "Visualization output was blocked.";
    sendToHost({ type: "error", requestId: message.requestId, message: root.textContent });
  }
}

function runVisualization(message) {
  stopWorker();
  activeRequestId = message.requestId;
  actionLocked = false;
  delete root.dataset.actionLocked;
  delete root.dataset.actionPending;
  root.textContent = "Running visualization…";
  if (!Array.isArray(message.notes) || message.notes.length > MAX_NOTES || !Array.isArray(message.trash) || message.trash.length > MAX_TRASH
    || !message.state || typeof message.state !== "object" || Array.isArray(message.state)
    || typeof message.javascript !== "string" || message.javascript.length > MAX_JAVASCRIPT_CHARS) {
    root.textContent = "Visualization input exceeded its size limit.";
    sendToHost({ type: "error", requestId: message.requestId, message: root.textContent });
    return;
  }
  const allowedImageSources = buildAllowedImageSources(message.notes);
  const serialized = JSON.stringify({ notes: message.notes, trash: message.trash, state: message.state });
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
    renderResult(event.data, allowedImageSources);
  };
  pendingEventId = undefined;
  delete root.dataset.actionPending;
  worker.postMessage({ requestId: message.requestId, notes: message.notes, trash: message.trash, state: message.state });
  workerTimer = setTimeout(() => {
    if (activeRequestId !== message.requestId) return;
    stopWorker();
    root.textContent = "Visualization stopped after 700 ms.";
    sendToHost({ type: "timeout", requestId: message.requestId });
  }, MAX_EXECUTION_MS);
}

function isSafePublicPosterReference(value) {
  if (typeof value !== "string" || value.length > 2_048 || [...value].some((character) => {
    const point = character.codePointAt(0) || 0;
    return point < 32 || point === 32 || point === 127;
  })) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.origin === "https://image.tmdb.org" && !url.username && !url.password && !url.port
    && !url.search && !url.hash && /^\/t\/p\/(?:w\d{1,4}|original)\/[A-Za-z0-9._/-]{1,1200}$/.test(url.pathname)
    && !url.pathname.split("/").some((segment) => segment === "." || segment === "..") && url.href === value;
}

function safeAssetPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024
    && !value.includes("\\") && ![...value].some((character) => {
      const point = character.codePointAt(0) || 0;
      return point < 32 || point === 127;
    }) && !/[?#]/.test(value) && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)
    && !value.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment === ".fieldnotes" || segment.startsWith(".fieldnotes-tmp-"))
    && /\.(?:jpe?g|png|webp)$/i.test(value);
}

function buildAllowedImageSources(notes) {
  const sources = new Set();
  for (const note of notes) {
    if (!note || !NOTE_ID_PATTERN.test(note.id || "") || !NOTE_HASH_PATTERN.test(note.contentHash || "")) continue;
    if (isSafePublicPosterReference(note.frontmatter?.poster)) {
      sources.add(`/api/views/assets/${note.id}?field=poster&v=${note.contentHash}`);
    }
    if (Array.isArray(note.assetPaths)) {
      for (const assetPath of note.assetPaths.slice(0, 20)) {
        if (sources.size >= MAX_ASSET_SOURCES) return sources;
        if (safeAssetPath(assetPath)) {
          sources.add(`/api/views/assets/${note.id}?asset=${encodeURIComponent(assetPath)}&v=${note.contentHash}`);
        }
      }
    }
    if (sources.size >= MAX_ASSET_SOURCES) break;
  }
  return sources;
}

function connect(event) {
  if (event.source !== window.parent || event.origin !== expectedParentOrigin) return;
  if (event.data?.type === "fieldnotes-view-ping") {
    window.parent.postMessage({ type: "fieldnotes-view-runner-ready" }, "*");
    return;
  }
  if (event.data?.type !== "fieldnotes-view-connect" || !event.ports[0]) return;
  if (hostPort) {
    hostPort.onmessage = null;
    hostPort.close();
  }
  stopWorker();
  activeRequestId = undefined;
  pendingEventId = undefined;
  actionLocked = false;
  delete root.dataset.actionPending;
  delete root.dataset.actionLocked;
  root.textContent = "Waiting for the Fieldnotes host…";
  hostPort = event.ports[0];
  hostPort.onmessage = (portEvent) => {
    const message = portEvent.data;
    if (message?.type === "cancel" && (message.requestId === undefined || message.requestId === activeRequestId)) {
      stopWorker();
      activeRequestId = undefined;
      actionLocked = false;
      pendingEventId = undefined;
      delete root.dataset.actionPending;
      delete root.dataset.actionLocked;
      root.textContent = "Waiting for the Fieldnotes host…";
      return;
    }
    if (message?.type === "action-result" && message.requestId === activeRequestId && message.eventId === pendingEventId) {
      pendingEventId = undefined;
      delete root.dataset.actionPending;
      if (message.ok === true) {
        root.dataset.actionLocked = "true";
        for (const control of root.querySelectorAll("button, input, textarea, select")) control.disabled = true;
      } else {
        actionLocked = false;
        delete root.dataset.actionLocked;
        root.dataset.actionResult = "error";
      }
      return;
    }
    if (message?.type === "run" && Number.isSafeInteger(message.requestId)) runVisualization(message);
  };
  hostPort.start();
  sendToHost({ type: "ready" });
}

window.addEventListener("message", connect);
