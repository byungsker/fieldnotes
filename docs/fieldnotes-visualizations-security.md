# Fieldnotes visualization security

`fieldnotes-view` is a native Fieldnotes Markdown block. It preserves its raw fence and does not install Dataview or implement its `dv` API. The default table and calendar render in the editor. An optional custom view runs a synchronous `fieldnotesRender(notes, escapeHtml)` body in a disposable Worker during local development.

## Read-only query contract

`POST /api/views/query` accepts a query with an optional folder UUID (or `null` for unfiled notes), search text up to 120 characters, up to 8 filters, an optional sort, and a limit from 1 to 200 (default 100). Supported fields are `title`, `path`, `createdAt`, `updatedAt`, `excerpt`, and `frontmatter.<key>`; nested frontmatter uses dot paths. Supported operators are `eq`, `contains`, `exists`, `before`, `after`, and `in`.

Returned records contain only a note ID, title, relative path, timestamps, a 150-character excerpt, and parsed frontmatter. The full Markdown body and absolute path are omitted. The server reads local Markdown to extract those values but scans at most 1,000 candidate notes / 20,000,000 UTF-8 bytes and caps the JSON response at 1.5 MB. A broad query over those bounds returns `413` and should be narrowed. The API is read-only.

Frontmatter parsing supports a safe subset of YAML scalars, lists, and mappings. It does not evaluate tags, constructors, or expressions. Unsupported or malformed frontmatter is reported as `frontmatterError`; it is not written back.

## Execution boundary and limits

The host sends only the bounded query result to an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, giving it an opaque origin with no host DOM, cookies, local storage, or authorization context. The runner checks the parent window and expected origin, checks the source window and opaque-origin ready signal, and transfers a dedicated `MessagePort` per view. The parent accepts only messages matching its current request ID. A block has one connection; each Worker accepts one render message and is terminated on completion, cancellation, or timeout.

The runner's CSP permits the static runner script only by its matching SHA-256 source and SRI attribute. Because the sandboxed frame has an opaque `null` origin, the server grants CORS access only to a GET for `/visualization-runner.js`; the script also carries a cross-origin resource policy header so the SRI-pinned asset can load. This exception does not cover API routes or other resources. `script-src` and `script-src-elem` otherwise allow only Blob URLs, so Worker imports work without enabling same-origin or network script sources. `connect-src`, image, font, media, frame, child, object, form, and manifest sources are denied. Chrome does not recognize a CSP WebRTC directive, so the renderer masks WebRTC APIs alongside fetch, XHR, WebSocket, EventSource, WebTransport, broadcast, storage, DOM, file, URL/Blob, timer, Worker, and importScripts globals on the Worker global and its prototype chain. It blocks `eval` / `Function` names and removes the constructor property from normal, async, generator, and async-generator function prototypes. `globalThis` remains available, so the isolation depends on those global/prototype masks and CSP together.

The Worker has a 700 ms parent-enforced deadline. Input is capped at 200 notes / 1 MB and JavaScript source at 12 KB. HTML is capped at 48 KB, CSS at 12 KB / 80 rules, and sanitized output at 500 elements / 20 levels. Only a small element / attribute / CSS property allowlist is copied to the runner DOM. Images, scripts, styles, frames, links, forms, media, and embedded objects are dropped; unsupported neutral elements are unwrapped. CSS `url()`, imports, font faces, escapes, and similar resource-loading syntax are rejected. At most 2 Workers run at once, with 6 waiting. Custom execution is disabled in production builds.

Browsers do not provide a portable hard per-Worker memory quota. The timer is best-effort under browser scheduling, and a script can allocate memory before its return value reaches the output-size checks. These controls do not protect against browser-engine vulnerabilities. Custom JS should remain disabled in production and should not be treated as safe for untrusted scripts.

## Failure behavior and verification

Unsupported query selectors, invalid block JSON, unsupported YAML, malformed XHTML, oversized input/output, too many DOM nodes, excessive CSS rules, a full queue, or a timeout produce a visible error or stopped-preview status. There is no file-write API or supported external-network API.

The automated suite checks the bounded query contract, CSP directives, iframe sandbox markup, generated Worker syntax and prototype masks, source roundtrips, stale request IDs, and concurrent Worker slots. Local Chrome checks verified the opaque origin, inaccessible host cookies and local storage, blocked loopback imports, removed Worker network APIs, image removal, live refresh, stale-result rejection, loading and error states, timeout termination, and desktop/mobile rendering. CSP behavior has not been runtime-verified in every supported browser; memory allocation also has no portable hard per-Worker quota.
