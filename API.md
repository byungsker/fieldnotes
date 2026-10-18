# Local API

All routes are under the same origin as the web app. Requests and responses are JSON unless noted; `GET /api/events` is Server-Sent Events. The server binds to loopback only. Local mode has no API login because it is reachable only on this Mac. For Tailscale Serve, configure both `KB_ALLOWED_TAILSCALE_LOGIN` and the exact HTTPS `KB_PUBLIC_ORIGIN`; the server then requires the matching `Tailscale-User-Login` header on every route, including static assets and SSE, and rejects requests that do not arrive over a loopback connection. Tailscale Serve removes incoming identity headers before adding the authenticated user value. Keep the API loopback-only and do not enable Express proxy trust. The CLI should use the Serve HTTPS origin in `KB_BASE_URL`, so its requests pass through the same identity proxy. The CLI's optional `KB_AUTH_TOKEN` is not validated by Fieldnotes itself.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health and database schema version |
| `GET` | `/api/vault/status` | Active storage mode, counts, and durable vault sequence |
| `GET` | `/api/vault/settings` | Current absolute server vault path and any saved next-restart selection |
| `GET` | `/api/vault/settings/directories?relativePath=...` | Browse real, non-symlink subdirectories under the server Mac's `Documents` folder |
| `POST` | `/api/vault/settings/verify` | Verify `{relativePath}` is an empty private folder or valid Fieldnotes vault |
| `POST` | `/api/vault/settings/selection` | Save a verified `{relativePath}` for the next server restart |
| `DELETE` | `/api/vault/settings/selection` | Clear the saved folder and return to the configured `KB_VAULT_DIR` |
| `GET` | `/api/documents?q=term&folderId=ID` | List or search notes; omit `folderId` for all notes, use `root` for unfiled notes |
| `POST` | `/api/documents` | Create `{title, body, folderId?, id?}`; `id` is an optional caller-generated UUID for safe retries; omit `folderId` or use `null` for unfiled |
| `GET` | `/api/documents/:id` | Read a complete note, including `version` |
| `POST` | `/api/views/query` | Read note metadata and a safe frontmatter subset for a local visualization; never mutates notes |
| `POST` | `/api/views/actions` | Validate and dispatch a bounded visualization action |
| `GET` | `/api/views/assets/:id?asset=...&v=...` | 문서 hash와 명시적 참조를 검증한 로컬 이미지 |
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

Vault settings accept relative paths only. The server resolves and checks each directory under its own `Documents` folder, rejects symbolic links and unmanaged contents, and saves the choice privately for startup. The current vault remains active until restart; selection does not move or delete data. In SQLite mode with existing notes, an empty target is rejected until the offline vault migration is completed.

### Read-only view query

`POST /api/views/query` accepts `{ "query": { ... } }`. Supported query options are `folderId` (UUID or `null` for unfiled notes), `search` (up to 120 characters), up to 8 `where` filters, an optional `sort`, `limit` (1–200, default 100), and `includeTrash` (boolean). Fields are `title`, `path`, `createdAt`, `updatedAt`, `excerpt`, or `frontmatter.<key>`; nested frontmatter keys may use dot paths. Operators are `eq`, `contains`, `exists`, `before`, `after`, and `in`. The response is `{ "notes": [...], "trash"?: [...], "sequence": number }`; each note includes `id`, `title`, relative `path`, timestamps, `version`, `contentHash`, a short `excerpt`, parsed `frontmatter`, and optional `frontmatterError` (no full note body or absolute path). If `includeTrash` is true, `trash` contains bounded records with `id`, `title`, `folderId`, `trashedAt`, `version`, and a short `excerpt`.

### Visualization actions

`POST /api/views/actions`는 공통 문서 액션을 처리한다. `note.create`는 멱등 재시도를 위해 호출자가 만든 UUID `actionId`를 요구한다. `note.update`, `note.frontmatter.patch`, `note.trash`는 현재 `expectedVersion`·`expectedHash`, `trash.restore`는 휴지통 문서의 `expectedVersion`이 필요하다. 허용 액션·필드·ID·크기를 검증하며 오래된 쓰기는 `409 version_conflict`다. 카테고리별 액션이나 API는 없고 분류 값은 사용자 frontmatter에 둔다. `movies.search`는 지원하지 않는다.

`GET /api/views/assets/:id?asset=<상대 경로>&v=<문서 hash>`는 해당 문서 본문에 명시한 로컬 JPEG·PNG·WebP·GIF·AVIF 이미지를 제공하며 25 MB로 제한한다. hash 불일치는 `409`, 미참조·외부 URL은 `404`, 과거 `field=poster`는 `400`이다. 원격 이미지는 다운로드하지 않는다. 상대 이미지 경로와 vault 최상위 경로를 해석하고, 경로 없는 wiki 첨부 링크는 vault 안에서 같은 이름의 파일이 하나일 때 제공한다. [사용자 JS 예시](docs/custom-js-record-views.md)와 [기존 뷰 이관](docs/custom-js-view-migration.md)을 참고한다.

The parser reads safe YAML scalars, lists, and mappings without evaluating tags, scripts, or expressions. Unsupported or malformed frontmatter is returned with `frontmatterError`; it is not written back. Query scans stop at 1,000 candidate notes or 20 MB of Markdown and responses are capped at 1.5 MB, so a broad query can return `413` and ask for a folder scope. The route uses the same loopback/origin and Tailscale identity checks as every other API endpoint.

Fieldnotes visualization blocks call this API from the host app. Custom JavaScript runs only after the user reviews and approves the exact source for that note and block; changed source requires approval again, and approval can be revoked. It receives the bounded result in a disposable Worker. The runner iframe has an opaque sandbox origin and no app storage access. Its CSP denies connection, image, media, font, frame, and form requests. The static runner script is allowed only by a matching SHA-256 CSP source and SRI hash; Worker scripts and imports are restricted to Blob URLs, with no same-origin or network script source. Worker execution is stopped after 700 ms; at most 2 custom visualizations run concurrently, with 6 queued. The browser does not expose a portable hard per-Worker heap quota, so input, execution time, output, and concurrency are bounded instead. See [the sandbox security limits](./docs/fieldnotes-visualizations-security.md).

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
