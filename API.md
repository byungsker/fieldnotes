# Local API

All routes are under the same origin as the web app. Requests and responses are JSON unless noted; `GET /api/events` is Server-Sent Events. The server binds to loopback only. Local mode has no API login because it is reachable only on this Mac. For Tailscale Serve, configure both `KB_ALLOWED_TAILSCALE_LOGIN` and the exact HTTPS `KB_PUBLIC_ORIGIN`; the server then requires the matching `Tailscale-User-Login` header on every route, including static assets and SSE, and rejects requests that do not arrive over a loopback connection. Tailscale Serve removes incoming identity headers before adding the authenticated user value. Keep the API loopback-only and do not enable Express proxy trust. The CLI should use the Serve HTTPS origin in `KB_BASE_URL`, so its requests pass through the same identity proxy. The CLI's optional `KB_AUTH_TOKEN` is not validated by Fieldnotes itself.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health and database schema version |
| `GET` | `/api/vault/status` | Active storage mode, counts, and durable vault sequence |
| `GET` | `/api/documents?q=term&folderId=ID` | List or search notes; omit `folderId` for all notes, use `root` for unfiled notes |
| `POST` | `/api/documents` | Create `{title, body, folderId?, id?}`; `id` is an optional caller-generated UUID for safe retries; omit `folderId` or use `null` for unfiled |
| `GET` | `/api/documents/:id` | Read a complete note, including `version` |
| `PUT` | `/api/documents/:id` | Update `{expectedVersion, title, body, folderId?, expectedHash?}`; `folderId` moves the note |
| `DELETE` | `/api/documents/:id` | Delete `{expectedVersion, expectedHash?}` |
| `GET` | `/api/folders` | List folders, including empty folders and direct-note counts |
| `POST` | `/api/folders` | Create `{name, parentId?}`; omit or use `null` for a top-level folder |
| `GET` | `/api/folders/:id` | Read a folder and its version |
| `PUT` | `/api/folders/:id` | Rename and/or move `{expectedVersion, name?, parentId?}`; use `null` for top level |
| `DELETE` | `/api/folders/:id` | Delete `{expectedVersion}`; only empty folders can be deleted |
| `GET` | `/api/backlinks/:id` | Find notes linking to a note title |
| `GET` | `/api/changes?after=SEQ` | Read durable changes after a cursor (up to 500 per page) |
| `GET` | `/api/changes/recent?limit=N` | Recent activity for the sidebar |
| `GET` | `/api/events?after=SEQ` | SSE live changes and reconnect replay |
| `POST` | `/api/import` | Import `{documents:[{title, body, folderId?}]}` (1–100 notes, 5 MB total); omit or use `null` for unfiled |
| `GET` | `/api/export` | Download versioned JSON export |

IDs are generated UUIDs. Folder names are 1–120 characters and cannot contain path separators or control characters. Duplicate folder names are rejected within the same parent. The hierarchy has no application-defined depth limit; practical limits are available memory, storage, and SQLite's recursive-query/runtime limits. Folder moves reject cycles. Deleting a non-empty folder returns `409` with `folder_not_empty` and never cascades to notes or subfolders.

Document and folder updates/deletes require the exact current version. Vault-mode clients should also send the `contentHash` returned with a document; the server checks the version and hash against the current Markdown file. A stale write returns `409` with `{error:"version_conflict", currentVersion, currentHash?}` and does not commit the requested mutation. Folder changes use `entityType:"folder"` and `folderId` in the durable change log; document changes retain `entityType:"document"` and `documentId`.

For a client-generated `id`, repeating a create request after an uncertain response returns the already-created document without creating another change event. The server rejects reusing an ID that was previously deleted. Updates and deletes remain guarded by their expected version and, in vault mode, the latest content hash.

In SQLite mode, mutations and change-log entries share a SQLite transaction. In filesystem mode, the `.md` write and private `.fieldnotes` operation journal are flushed before success. The SQLite file `vault-index.sqlite` is a rebuildable search index. API requests reconcile the vault before reading or writing, and an OS file watcher plus periodic scan notices edits made in Finder or another Markdown editor. Markdown responses then include a vault-relative `filePath` and SHA-256 `contentHash`; SQLite-mode responses omit them.

Each SSE `change` event has a monotonically increasing `id` and JSON data:

```json
{"seq":18,"entityType":"document","documentId":"...","title":"Example","operation":"updated","version":4,"createdAt":"2026-10-06T09:00:00.000Z"}
```

Folder event example:

```json
{"seq":19,"entityType":"folder","folderId":"...","title":"Projects","operation":"updated","version":2,"createdAt":"2026-10-06T09:05:00.000Z"}
```

Send `Last-Event-ID` on reconnect. The server replays changes after that sequence before subscribing to new events. Clients can also query `/api/changes?after=SEQ` to reconcile across reloads or a server outage.

## Example agent write

```sh
curl http://127.0.0.1:4177/api/documents/NOTE_ID
curl -X PUT http://127.0.0.1:4177/api/documents/NOTE_ID \
  -H 'content-type: application/json' \
  -d '{"expectedVersion":3,"expectedHash":"<sha256 from the last read>","title":"Example","body":"Updated Markdown"}'
```

## Folder examples

```sh
curl http://127.0.0.1:4177/api/folders
curl -X POST http://127.0.0.1:4177/api/folders \
  -H 'content-type: application/json' \
  -d '{"name":"Projects","parentId":null}'
curl -X PUT http://127.0.0.1:4177/api/folders/FOLDER_ID \
  -H 'content-type: application/json' \
  -d '{"expectedVersion":1,"name":"Active projects","parentId":null}'
curl 'http://127.0.0.1:4177/api/documents?folderId=FOLDER_ID'
```
