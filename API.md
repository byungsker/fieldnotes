# Local API

All routes are under the same origin as the web app. Requests and responses are JSON unless noted; `GET /api/events` is Server-Sent Events. The server binds to loopback only. There is no CORS access or remote authentication in this MVP.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health and database schema version |
| `GET` | `/api/documents?q=term` | List or full-text search note summaries |
| `POST` | `/api/documents` | Create `{title, body}` |
| `GET` | `/api/documents/:id` | Read a complete note, including `version` |
| `PUT` | `/api/documents/:id` | Update `{expectedVersion, title, body}` |
| `DELETE` | `/api/documents/:id` | Delete `{expectedVersion}` |
| `GET` | `/api/backlinks/:id` | Find notes linking to a note title |
| `GET` | `/api/changes?after=SEQ` | Read durable changes after a cursor (up to 500 per page) |
| `GET` | `/api/changes/recent?limit=N` | Recent activity for the sidebar |
| `GET` | `/api/events?after=SEQ` | SSE live changes and reconnect replay |
| `POST` | `/api/import` | Import `{documents:[{title, body}]}` (1–100 notes, 5 MB total) |
| `GET` | `/api/export` | Download versioned JSON export |

IDs are generated UUIDs. Titles are 1–160 characters and bodies are at most 250 KB each. Update and delete require the exact current version. A stale write returns `409` with `{error:"version_conflict", currentVersion}`; no change or change-log entry is committed. Create/update/delete/import and their change-log entries share a SQLite transaction.

Each SSE `change` event has a monotonically increasing `id` and JSON data:

```json
{"seq":18,"documentId":"...","title":"Example","operation":"updated","version":4,"createdAt":"2026-10-06T09:00:00.000Z"}
```

Send `Last-Event-ID` on reconnect. The server replays changes after that sequence before subscribing to new events. Clients can also query `/api/changes?after=SEQ` to reconcile across reloads or a server outage.

## Example agent write

```sh
curl http://127.0.0.1:4177/api/documents/NOTE_ID
curl -X PUT http://127.0.0.1:4177/api/documents/NOTE_ID \
  -H 'content-type: application/json' \
  -d '{"expectedVersion":3,"title":"Example","body":"Updated Markdown"}'
```
