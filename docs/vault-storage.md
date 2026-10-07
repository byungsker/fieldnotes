# Filesystem vault storage

Fieldnotes starts in SQLite mode unless `KB_VAULT_DIR` is configured. In filesystem mode, UTF-8 `.md` and `.markdown` files plus the hidden `.fieldnotes/state.json` manifest are authoritative. `vault-index.sqlite` is a local, rebuildable index for search, backlinks, and API reads. The manifest keeps stable IDs, folders, hashes, versions, and the durable change sequence; it does not contain note bodies.

The vault must be a Fieldnotes-owned directory under `KB_DATA_DIR`. Do not point it at an Obsidian/iCloud vault. Fieldnotes indexes Markdown files recursively and treats directories as folders. Other regular files are preserved by vault backup but are not indexed. `.fieldnotes` and `.fieldnotes-tmp-*` names are reserved; symbolic links, invalid UTF-8, name collisions that cannot be represented safely, or files over the documented size limit stop reconciliation without overwriting the files.

## Convert an existing SQLite library

This conversion reads the existing Fieldnotes SQLite library and writes a new app-owned directory. It does not read or modify any Obsidian vault. Keep the service stopped through backup and migration, and do not edit the source database or new vault during the conversion.

1. Stop Fieldnotes cleanly. SIGTERM closes active SSE streams, rejects new requests, drains accepted requests, closes idle keep-alive connections, and only then closes SQLite and removes its own lock. Confirm `data/server.lock` is absent. If a lock remains, inspect the process and do not delete the lock until you confirm the process has exited.

   If a LaunchAgent or other supervisor manages Fieldnotes, inspect its exact label and working directory, then temporarily unload that one job before stopping the server so `KeepAlive` cannot start a second copy during maintenance. After migration, load that same job once; do not also run `npm start` manually.
2. Create a standalone snapshot with SQLite's online backup mechanism. Use a private, ignored location and do not overwrite an existing backup:

   ```sh
   npm run db:backup -- ./data/private-backups/fieldnotes-pre-vault.sqlite
   ```

   The script uses `VACUUM INTO`, checks `quick_check`, and includes committed WAL data.
3. Convert using that backup. The script checks `quick_check`, compares the stopped live database against the backup row by row (including Markdown bodies, folders, and change history), stages a new vault, verifies every document body and stable ID, and writes a private path manifest. It refuses an existing destination or manifest.

   ```sh
   npm run vault:migrate -- \
     --backup ./data/private-backups/fieldnotes-pre-vault.sqlite \
     --vault-dir ./data/vaults/default \
     --manifest ./data/private-backups/fieldnotes-migration-manifest.json \
     --server-stopped
   ```
4. Review the verification counts. Add `KB_VAULT_DIR=./data/vaults/default` to `.env`, then start Fieldnotes. Startup reconciles the manifest and rebuilds `vault-index.sqlite`; the original `knowledge.sqlite` stays in place and is not modified.
5. Check `npm run kb -- vault status`, then open a few notes in the UI and confirm the same notes through `npm run kb -- list` and `read`.

Migration preserves note IDs, titles, Markdown bytes, folder IDs, versions, timestamps, and history sequence. Filenames are encoded and bounded for portable filesystems; duplicate titles receive stable ID suffixes. Folder display names remain in the manifest if their physical path needs encoding. The private migration manifest contains note titles and paths, so keep it under the ignored, mode-700 `data/private-backups` directory.

Opening a schema v2 SQLite database with this release upgrades its schema to v3 by adding file metadata columns with empty defaults. This is a metadata-only SQLite migration: document bodies, IDs, folders, and history remain in SQLite. Filesystem storage begins only when `KB_VAULT_DIR` points to a verified Fieldnotes vault.

If verification fails, the script exits before changing `.env`; the original SQLite file remains available. A failed conversion removes only the temporary staging directory it created. Inspect and resolve the reported issue, then run again with a new destination and manifest name.

## Editing and synchronization

The app writes Markdown atomically and durably before returning a successful save. It updates the manifest and change sequence, then refreshes the SQLite index. A filesystem watcher accelerates external-change detection; a periodic full scan and reconciliation on API requests provide recovery if watcher events are missed. Clients receive saved updates through SSE and can request changes after their last sequence.

Edit the `.md` files with a Markdown editor or Finder-aware editor while the app runs. A changed file increments its version and adds a change event. A UI or CLI save based on an older version or hash returns HTTP 409; the UI preserves the unsaved draft until the user loads or merges the latest version. Do not edit `.fieldnotes/state.json` by hand. Avoid simultaneous edits to the same file from an editor that writes in place while Fieldnotes saves; close the app or let one writer finish first.

Titles may contain punctuation or path-like text; Fieldnotes encodes those characters into a single safe filename component. Folder names reject path separators and reserved names. Filesystem names are normalized for collision checks, including case and Unicode equivalents.

## Backup and restore

For a complete, verified vault backup, stop Fieldnotes and close any editor that is writing into the vault. The backup command reconciles the vault and rebuilds its SQLite index first, copies the vault and manifest to a new directory, then verifies document bodies, IDs, folders, and change history. It refuses to overwrite a destination:

```sh
npm run vault:backup -- --server-stopped
```

To choose a destination, add `--destination /path/to/fieldnotes-vault-backup`. The default is a timestamped directory under `data/private-backups`.

Restore always creates a new app-owned directory and leaves the source backup and any existing vault untouched:

```sh
npm run vault:restore -- \
  --backup-dir /path/to/fieldnotes-vault-backup \
  --vault-dir ./data/vaults/restored \
  --server-stopped
```

Review the restored copy before setting `KB_VAULT_DIR` to it. Startup rebuilds the SQLite index from the restored files and manifest. `npm run db:backup` in filesystem mode snapshots `vault-index.sqlite` with `VACUUM INTO`; use that SQLite snapshot for rollback or database-only inspection, not as the only complete vault backup.

## Roll back to SQLite

For a rollback that includes all changes made since migration, stop Fieldnotes and make a current SQLite index snapshot while the vault is still configured:

```sh
npm run db:backup -- ./data/private-backups/fieldnotes-current-index.sqlite
KB_DATA_DIR=./data/sqlite-rollback npm run db:restore -- \
  ./data/private-backups/fieldnotes-current-index.sqlite --server-stopped
```

Then set `KB_DATA_DIR=./data/sqlite-rollback`, remove or comment out `KB_VAULT_DIR` in `.env`, and restart. This uses a new SQLite directory; the original pre-migration `data/knowledge.sqlite`, active Markdown vault, and backups remain untouched. If only `KB_VAULT_DIR` is unset without restoring the current index into a new data directory, the app returns to the older pre-migration SQLite snapshot and will not include later vault-only edits.

## Portability

Transfer the source, lockfile, setup docs, `.env.example`, and a verified vault backup to the other Mac. Do not transfer architecture-specific `node_modules`. Install the pinned dependencies with `npm ci`, set `KB_DATA_DIR` and `KB_VAULT_DIR` to persistent directories outside source control, build with `npm run build`, then run `npm start`. Restore into a new vault path before changing the active configuration. Do not expose the service publicly or weaken its private identity checks to make migration work.
