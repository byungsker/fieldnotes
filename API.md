# Local API

All routes are under the same origin as the web app. Requests and responses are JSON unless noted; `GET /api/events` is Server-Sent Events. The server binds to loopback only. There is no CORS access or API authentication in this MVP. The CLI forwards optional `KB_AUTH_TOKEN` as a Bearer token only to HTTPS origins or loopback; Fieldnotes itself does not validate it. For private remote use, terminate HTTPS behind an identity-aware proxy that validates browser and CLI authentication on every route, including SSE, before forwarding to the loopback API.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health and database schema version |
| `GET` | `/api/documents?q=term&folderId=ID` | List or search notes; omit `folderId` for all notes, use `root` for unfiled notes |
| `POST` | `/api/documents` | Create `{title, body, folderId?}`; omit or use `null` for unfiled |
| `GET` | `/api/documents/:id` | Read a complete note, including `version` |
| `PUT` | `/api/documents/:id` | Update `{expectedVersion, title, body, folderId?}`; `folderId` moves the note |
| `DELETE` | `/api/documents/:id` | Delete `{expectedVersion}` |
| `GET` | `/api/folders` | List folders, including empty folders and direct-note counts |
| `POST` | `/api/folders` | Create `{name, parentId?}`; omit or use `null` for a top-level folder |
| `GET` | `/api/folders/:id` | Read a folder and its version |
| `PUT` | `/api/folders/:id` | Rename and/or move `{expectedVersion, name?, parentId?}`; use `null` for top level |
| `DELETE` | `/api/folders/:id` | Delete `{expectedVersion}`; only empty folders can be deleted |
| `GET` | `/api/backlinks/:id` | Find notes linking to a note title |
| `GET` | `/api/changes?after=SEQ` | Read durable changes after a cursor (up to 500 per page) |
| `GET` | `/api/changes/recent?limit=N` | Recent activity for the sidebar |
| `GET` | `/api/events?after=SEQ` | SSE live changes and reconnect replay |
| `POST` | `/api/import` | Import `{documents:[{title, body}]}` (1–100 notes, 5 MB total) |
| `GET` | `/api/export` | Download versioned JSON export |

IDs are generated UUIDs. Folder names are 1–120 characters and cannot contain path separators or control characters. Duplicate folder names are rejected within the same parent. The hierarchy has no application-defined depth limit; practical limits are available memory, storage, and SQLite's recursive-query/runtime limits. Folder moves reject cycles. Deleting a non-empty folder returns `409` with `folder_not_empty` and never cascades to notes or subfolders.

Document and folder updates/deletes require the exact current version. A stale write returns `409` with `{error:"version_conflict", currentVersion}`; no change or change-log entry is committed. Folder changes use `entityType:"folder"` and `folderId` in the durable change log; document changes retain `entityType:"document"` and `documentId`. Mutations and their change-log entries share a SQLite transaction.

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
  -d '{"expectedVersion":3,"title":"Example","body":"Updated Markdown"}'
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
