# Fieldnotes — personal knowledge base

Fieldnotes is a local-first Markdown notebook with a React + TypeScript interface and a Node API. SQLite is authoritative in the default setup. When `KB_VAULT_DIR` is configured, Markdown files become authoritative and SQLite is a rebuildable search/change index. People and coding agents use the same version-checked API in either mode.

## Run locally

Requirements: Node.js 22.13 or newer (the app uses the built-in `node:sqlite` module).

```sh
cp .env.example .env
npm ci
npm run dev
```

Open [http://127.0.0.1:4177](http://127.0.0.1:4177). The Vite UI proxies `/api` to the local Node API. For a production-style local run, use `npm run build` and then `npm start`; it serves the built UI and API from the same local origin.

The first SQLite database gets three clearly labeled demo notes. They contain no imported user data. Demo seeding runs once; deleting all notes later does not recreate them. `.env` is optional and contains no secrets. The default API port is 4178 during development and 4177 for `npm start`; leave `KB_PORT` unset for these defaults. If you change ports, update `KB_API_ORIGIN` for the Vite proxy and set `KB_BASE_URL` to the local API origin for the CLI.

## Use the app

- Create, edit, search, and delete Markdown notes.
- Navigate with browser history. The desktop sidebar and mobile drawer use one nested file tree for folders and notes, with search, sort, create, rename, and move actions. The library is `/`, recent activity is `/recent`, folders use `/folders/<folder-id>` (or `/folders/unfiled`), and notes use `/notes/<note-id>`. These URLs can be bookmarked and reloaded directly.
- On small screens, opening a note becomes a full-screen editor route. Confirmations and rename prompts use keyboard-aware, accessible dialogs; Back closes an open dialog before leaving the current route.
- Create an unlimited number of nested folders, including empty folders. Expand or collapse folders to see their notes in the tree; select a folder to browse its direct notes, create notes in it, rename or move folders and notes, and drag a note onto a folder. Deleting a folder is allowed only when it has no notes or subfolders.
- Sort notes by title A–Z/Z–A or updated time, newest/oldest. Sorting composes with the selected all-notes, unfiled, or folder view and text search; Reset clears the search and folder selection and returns to newest updates.
- Notes open directly in the rich Markdown editor. Supported Markdown renders as editable text, headings, lists, links, code blocks, bookmark cards, and images; syntax that cannot round-trip exactly falls back to source editing rather than being silently rewritten. A closed YAML frontmatter block is protected and shown with a “Frontmatter preserved” badge. Changes autosave after a short pause; title, Markdown, and folder move together in one version-checked update. Saving waits until Korean IME composition ends. `⌘S` flushes a pending sync immediately.
- Dark theme is the first-use default regardless of OS appearance. The sun/moon control switches themes and stores the explicit choice for future visits.
- Write `[[Note title]]` to link a note. Links resolve by case-insensitive title; backlinks appear below the editor. Unresolved links remain visible.
- See saved activity and live changes from other browser tabs or agents. SQLite mode commits each change transactionally before success. Vault mode durably writes the Markdown file and its `.fieldnotes` operation log before success, then refreshes the rebuildable SQLite index. Both modes publish through SSE and replay saved changes after reconnect.
- New notes stay local until the first meaningful edit. Drafts are kept in this browser while they sync, including after a network failure or reload. A Retry action resends a failed update; an external change pauses autosave and offers Load latest or an explicit Replace with my draft action. Unsaved drafts also trigger the browser's close warning.
- Import one or more `.md` or `.markdown` files without changing their text. Export the whole library as a versioned JSON file. This is generic Markdown import; front matter and Markdown remain text, but Obsidian plugins, attachments, embeds, and all vault-specific syntax are not promised to work.

## Agent CLI

The CLI calls the same API the UI uses. Codex, Hermes, Claude Code, or another local agent can invoke it through the shell:

```sh
npm run kb -- list
npm run kb -- search "meeting notes"
npm run kb -- folder list
npm run kb -- folder create --name "Projects"
npm run kb -- folder create --name "Research" --parent FOLDER_ID
npm run kb -- read NOTE_ID
npm run kb -- create --title "New note" --file ./new-note.md --folder FOLDER_ID
npm run kb -- update NOTE_ID --version 3 --file ./revised-note.md --folder FOLDER_ID
npm run kb -- move-document NOTE_ID --version 4 --folder root
npm run kb -- folder rename FOLDER_ID --version 1 --name "Active projects"
npm run kb -- folder move FOLDER_ID --version 2 --parent root
npm run kb -- folder delete FOLDER_ID --version 3
npm run kb -- delete NOTE_ID --version 4
```

`update` and `delete` require the version seen on the last read. In vault mode the CLI also sends the Markdown SHA-256 it read; a stale version or file hash returns a conflict and makes no change. `npm run kb -- vault status` reports the active storage mode. For direct clients, see [API.md](./API.md). Set `KB_BASE_URL` for a different local/private API origin; the default is `http://127.0.0.1:4177`.

`folder list` prints the hierarchy and each folder's version. Folder rename, move, and delete require `--version` from the latest folder list/read. Empty folders are first-class records. Folder names cannot contain `/`, `\\`, control characters, `.` or `..`; duplicate sibling names and cyclic moves are rejected. There is no configured depth or folder-count cap, subject to available storage and runtime limits.

## Data, backup, and restore

Persistent data lives under `KB_DATA_DIR` and is ignored by Git. The default SQLite database is `./data/knowledge.sqlite`; use an absolute `KB_DATA_DIR` to keep data outside the source tree. SQLite uses WAL mode and `synchronous=FULL`.

Create and verify a safe SQLite snapshot while Fieldnotes is running:

```sh
npm run db:backup -- /path/to/backups/fieldnotes-YYYY-MM-DD.sqlite
```

This uses SQLite `VACUUM INTO`, so the snapshot includes committed WAL data. It does not copy a live database file directly. In filesystem mode the command snapshots `vault-index.sqlite`, which contains the current indexed state and can be used for a SQLite rollback. The app also offers a versioned JSON export from the UI and `/api/export`.

To restore, stop Fieldnotes first. The restore script requires `--server-stopped`, checks the server lock and SQLite integrity, stages the replacement in the data directory, and creates a `pre-restore-*.sqlite` snapshot of current data before replacing it:

```sh
npm run db:restore -- /path/to/fieldnotes-backup.sqlite --server-stopped
```

The database schema is version 3; startup migrates older SQLite databases forward. `db:restore` accepts supported versions and applies pending migrations at the next start. Keep the code version and its data backup together when moving machines.

For filesystem mode, stop Fieldnotes before making a complete vault backup. It includes Markdown files and `.fieldnotes/state.json`; the SQLite index can be rebuilt from that metadata and the files:

```sh
npm run vault:backup -- --server-stopped
npm run vault:restore -- --backup-dir /path/to/fieldnotes-vault-backup --vault-dir ./data/vaults/restored --server-stopped
```

Restore creates a new directory and refuses to overwrite an existing vault. Review the restored copy, then point `KB_VAULT_DIR` at it. For exact offline SQLite-to-Markdown conversion, see [docs/vault-storage.md](./docs/vault-storage.md).

## Moving to another Mac

Transfer the project source, `package.json`, `package-lock.json`, and `.env.example`; do not transfer `node_modules`. On the target Mac, install Node.js 22.13+, run `npm ci`, choose a persistent `KB_DATA_DIR`, restore a verified vault or SQLite backup, then run `npm run build` and `npm start`. Import only content you intend to store in this app.

## Remote access

The server refuses non-loopback `KB_HOST` values. For private Tailscale Serve use, set `KB_ALLOWED_TAILSCALE_LOGIN` to the exact permitted tailnet login and `KB_PUBLIC_ORIGIN` to the Serve HTTPS origin, for example `https://your-machine.example.invalid:8443`; the app refuses to start if only one is configured. The API requires the matching `Tailscale-User-Login` header on every route and accepts it only from a loopback connection. Tailscale Serve strips client-supplied identity headers and injects the authenticated user's identity; keep Fieldnotes bound to `127.0.0.1` and do not enable Express proxy trust. Restrict Tailscale access to the same user rather than all tailnet members. Set `KB_BASE_URL` for agent CLI clients to the Serve HTTPS origin so their requests pass through that proxy. `KB_PUBLIC_ORIGIN` is an origin/CSRF check, not authentication. This project does not configure Serve, tailnet policy, credentials, firewall, or autostart; test the complete path before enabling it.
