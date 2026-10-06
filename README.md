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

The first database gets three clearly labeled demo notes. They contain no imported user data. Demo seeding runs once; deleting all notes later does not recreate them. `.env` is optional and contains no secrets; edit it only to change local paths or ports.

## Use the app

- Create, edit, preview, search, and delete Markdown notes.
- Write `[[Note title]]` to link a note. Links resolve by case-insensitive title; backlinks appear in Preview. Unresolved links remain visible.
- See saved activity and live changes from other browser tabs or agents. Each saved change is committed to SQLite before success is returned and then published through SSE. Reconnecting clients replay the durable change log and refresh current notes.
- If a note changes while you have a draft open, Fieldnotes keeps your text in the editor and marks the conflict. Load the latest version to replace the draft, or save after resolving it.
- Import one or more `.md` or `.markdown` files without changing their text. Export the whole library as a versioned JSON file. This is generic Markdown import; front matter and Markdown remain text, but Obsidian plugins, attachments, embeds, and all vault-specific syntax are not promised to work.

## Agent CLI

The CLI calls the same API the UI uses. Codex, Hermes, Claude Code, or another local agent can invoke it through the shell:

```sh
npm run kb -- list
npm run kb -- search "meeting notes"
npm run kb -- read NOTE_ID
npm run kb -- create --title "New note" --file ./new-note.md
npm run kb -- update NOTE_ID --version 3 --file ./revised-note.md
npm run kb -- delete NOTE_ID --version 4
```

`update` and `delete` require the version seen on the last read. A stale version returns a conflict and makes no change. For direct clients, see [API.md](./API.md). Set `KB_BASE_URL` for a different local/private API origin; the default is `http://127.0.0.1:4177`.

## Data, backup, and restore

The default database is `./data/knowledge.sqlite`, separate from source code and ignored by Git. Change its location with `KB_DATA_DIR` in `.env`; use an absolute path to keep data outside the project directory. Each save uses a SQLite transaction, WAL journal mode, and `synchronous=FULL`.

Create and verify a safe SQLite snapshot while Fieldnotes is running:

```sh
npm run db:backup -- /path/to/backups/fieldnotes-YYYY-MM-DD.sqlite
```

This uses SQLite `VACUUM INTO`, so the snapshot includes committed WAL data. It does not copy the live database file directly. The app also offers a JSON export from the UI and `/api/export`.

To restore, stop Fieldnotes first. The restore script requires `--server-stopped`, checks the server lock and SQLite integrity, stages the replacement in the data directory, and creates a `pre-restore-*.sqlite` snapshot of current data before replacing it:

```sh
npm run db:restore -- /path/to/fieldnotes-backup.sqlite --server-stopped
```

If a schema migration is added later, back up first, review the migration in `server/database.ts`, then run `npm run db:migrate`. The service applies forward migrations on startup too; the explicit command reports the current schema version. Keep the code version and data backup together when moving machines.

## Moving to another Mac

Transfer the project source, `package.json`, `package-lock.json`, and `.env.example`; do not transfer `node_modules`. On the target Mac, install Node.js 22.13+, run `npm ci`, choose a persistent `KB_DATA_DIR`, and run `npm run build` then `npm start`. Restore a verified SQLite backup using the offline procedure above. Import only content you intend to store in this app.

## Remote access

The server refuses non-loopback `KB_HOST` values and the API does not implement user accounts or authentication tokens. Keep it on `127.0.0.1`; do not expose it directly to a network. Any remote deployment needs a separately reviewed identity-aware access layer and verification of writes and SSE connections before use.
