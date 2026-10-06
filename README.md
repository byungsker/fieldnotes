# Fieldnotes — personal knowledge base

Fieldnotes is a local-first Markdown notebook with a React + TypeScript interface, a Node API, and SQLite as the authoritative store. It is meant to be useful to both a person and local coding agents through the same version-checked API.

## Run locally

Requirements: Node.js 22.13 or newer (the app uses the built-in `node:sqlite` module).

```sh
cp .env.example .env
npm ci
npm run dev
```

Open [http://127.0.0.1:4177](http://127.0.0.1:4177). The Vite UI proxies `/api` to the local Node API. For a production-style local run, use `npm run build` and then `npm start`; it serves the built UI and API from the same local origin.

The first database gets three clearly labeled demo notes. They contain no imported user data. Demo seeding runs once; deleting all notes later does not recreate them. `.env` is optional and contains no secrets. The default API port is 4178 during development and 4177 for `npm start`; leave `KB_PORT` unset for these defaults. If you change ports, update `KB_API_ORIGIN` for the Vite proxy and set `KB_BASE_URL` to the local API origin for the CLI.

## Use the app

- Create, edit, preview, search, and delete Markdown notes.
- Navigate with browser history and Stackflow transitions. The library is `/`, recent activity is `/recent`, folders use `/folders/<folder-id>` (or `/folders/unfiled`), and notes use `/notes/<note-id>`. These URLs can be bookmarked and reloaded directly.
- On small screens, opening a note becomes a full-screen editor route. Confirmations and rename prompts use keyboard-aware, accessible dialogs; Back closes an open dialog before leaving the current route.
- Create an unlimited number of nested folders, including empty folders. Select folders to browse direct notes, create notes in the current folder, rename or move folders, and move notes between folders. Deleting a folder is allowed only when it has no notes or subfolders.
- Write `[[Note title]]` to link a note. Links resolve by case-insensitive title; backlinks appear in Preview. Unresolved links remain visible.
- See saved activity and live changes from other browser tabs or agents. Each saved change is committed to SQLite before success is returned and then published through SSE. Reconnecting clients replay the durable change log and refresh current notes.
- If a note changes while you have a draft open, Fieldnotes keeps your text in the editor and marks the conflict. Load the latest version to replace the draft, or save after resolving it.
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

`update` and `delete` require the version seen on the last read. A stale version returns a conflict and makes no change. For direct clients, see [API.md](./API.md). Set `KB_BASE_URL` for a different local/private API origin; the default is `http://127.0.0.1:4177`.

`folder list` prints the hierarchy and each folder's version. Folder rename, move, and delete require `--version` from the latest folder list/read. Empty folders are first-class records. Folder names cannot contain `/`, `\\`, control characters, `.` or `..`; duplicate sibling names and cyclic moves are rejected. There is no configured depth or folder-count cap, subject to available storage and runtime limits.

## Data, backup, and restore

The default database is `./data/knowledge.sqlite`, separate from source code and ignored by Git. Change its location with `KB_DATA_DIR` in `.env`; use an absolute path to keep data outside the project directory. Each save uses a SQLite transaction, WAL journal mode, and `synchronous=FULL`.

Create and verify a safe SQLite snapshot while Fieldnotes is running:

```sh
npm run db:backup -- /path/to/backups/fieldnotes-YYYY-MM-DD.sqlite
```

This uses SQLite `VACUUM INTO`, so the snapshot includes committed WAL data. It does not copy the live database file directly. The app also offers a versioned JSON export from the UI and `/api/export`; exports include the folder hierarchy and each note's folder ID.

To restore, stop Fieldnotes first. The restore script requires `--server-stopped`, checks the server lock and SQLite integrity, stages the replacement in the data directory, and creates a `pre-restore-*.sqlite` snapshot of current data before replacing it:

```sh
npm run db:restore -- /path/to/fieldnotes-backup.sqlite --server-stopped
```

The folder hierarchy uses SQLite schema version 2. The app migrates version 1 databases forward on startup. Before an explicit migration, stop Fieldnotes, make a verified backup, review the migration in `server/database.ts`, then run `npm run db:migrate`; the script refuses to run while a server lock exists. If it reports a stale lock, verify that no Fieldnotes process is using that data directory, remove only the stale `server.lock`, and retry. Restore accepts schema versions supported by this app and the next start applies pending forward migrations. Keep the code version and data backup together when moving machines.

## Moving to another Mac

Transfer the project source, `package.json`, `package-lock.json`, and `.env.example`; do not transfer `node_modules`. On the target Mac, install Node.js 22.13+, run `npm ci`, choose a persistent `KB_DATA_DIR`, and run `npm run build` then `npm start`. Restore a verified SQLite backup using the offline procedure above. Import only content you intend to store in this app.

## Remote access

The server refuses non-loopback `KB_HOST` values. For private Tailscale Serve use, set `KB_ALLOWED_TAILSCALE_LOGIN` to the exact permitted tailnet login and `KB_PUBLIC_ORIGIN` to the Serve HTTPS origin, for example `https://machine.tailnet.ts.net:8443`; the app refuses to start if only one is configured. The API requires the matching `Tailscale-User-Login` header on every route and accepts it only from a loopback connection. Tailscale Serve strips client-supplied identity headers and injects the authenticated user's identity; keep Fieldnotes bound to `127.0.0.1` and do not enable Express proxy trust. Restrict Tailscale access to the same user rather than all tailnet members. Set `KB_BASE_URL` for agent CLI clients to the Serve HTTPS origin so their requests pass through that proxy. `KB_PUBLIC_ORIGIN` is an origin/CSRF check, not authentication. This project does not configure Serve, tailnet policy, credentials, firewall, or autostart; test the complete path before enabling it.
