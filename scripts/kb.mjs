#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const baseUrl = (process.env.KB_BASE_URL ?? "http://127.0.0.1:4177").replace(/\/$/, "");
const authToken = process.env.KB_AUTH_TOKEN;
const [command, ...arguments_] = process.argv.slice(2);

function usage() {
  console.log(`Fieldnotes CLI — use the same local API as the web app

Usage:
  node scripts/kb.mjs list [--query TEXT]
  node scripts/kb.mjs search TEXT
  node scripts/kb.mjs read ID
  node scripts/kb.mjs create --title TITLE [--file PATH | --body TEXT] [--folder ID]
  node scripts/kb.mjs update ID --version N [--title TITLE] [--file PATH | --body TEXT] [--folder ID|root]
  node scripts/kb.mjs delete ID --version N
  node scripts/kb.mjs move-document ID --version N --folder ID|root
  node scripts/kb.mjs folder list
  node scripts/kb.mjs folder create --name NAME [--parent ID|root]
  node scripts/kb.mjs folder rename ID --version N --name NAME
  node scripts/kb.mjs folder move ID --version N --parent ID|root
  node scripts/kb.mjs folder delete ID --version N
  node scripts/kb.mjs vault status

Set KB_BASE_URL to point at a different private instance. Writes use version checks.`);
}

function parseArguments(values) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith("--")) {
      const name = value.slice(2);
      const next = values[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for --${name}.`);
      flags[name] = next;
      index += 1;
    } else {
      positionals.push(value);
    }
  }
  return { positionals, flags };
}

async function request(path, init) {
  const target = new URL(path, `${baseUrl}/`);
  const headers = new Headers(init?.headers);
  if (authToken) {
    const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
    if (target.protocol !== "https:" && !isLoopback) {
      throw new Error("KB_AUTH_TOKEN may only be sent to HTTPS origins or loopback.");
    }
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  const response = await fetch(target, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message ?? `Request failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.code = body.error;
    error.currentVersion = body.currentVersion;
    error.currentHash = body.currentHash;
    throw error;
  }
  if (response.status === 204) return undefined;
  return response.json();
}

function json(method, body) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function bodyFrom(flags, fallback = "") {
  if (flags.file) return readFile(flags.file, "utf8");
  if (flags.body !== undefined) return flags.body;
  return fallback;
}

function versionFlag(flags) {
  if (!flags.version) throw new Error("This operation requires --version from the last read.");
  const version = Number(flags.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("--version must be a positive integer.");
  return version;
}

function printDocuments(documents) {
  if (!documents.length) {
    console.log("No notes found.");
    return;
  }
  for (const note of documents) {
    const excerpt = note.excerpt ? ` — ${note.excerpt}` : "";
    const filePath = note.filePath ? `  [${note.filePath}]` : "";
    console.log(`${note.id}  v${note.version}  ${note.title}${filePath}${excerpt}`);
  }
}

async function main() {
  if (!command || command === "help" || command === "--help") return usage();
  const { positionals, flags } = parseArguments(arguments_);

  if (command === "list" || command === "search") {
    const query = command === "search" ? positionals.join(" ") : flags.query ?? "";
    const result = await request(`/api/documents${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    return printDocuments(result.documents);
  }

  if (command === "read") {
    const id = positionals[0];
    if (!id) throw new Error("read requires a note ID.");
    const { document } = await request(`/api/documents/${encodeURIComponent(id)}`);
    console.log(JSON.stringify({ id: document.id, title: document.title, version: document.version, updatedAt: document.updatedAt, filePath: document.filePath, contentHash: document.contentHash }, null, 2));
    console.log("\n--- Markdown ---\n");
    console.log(document.body);
    return;
  }

  if (command === "create") {
    if (!flags.title) throw new Error("create requires --title.");
    const body = await bodyFrom(flags);
    const payload = { title: flags.title, body };
    if (flags.folder) payload.folderId = flags.folder === "root" ? null : flags.folder;
    const { document } = await request("/api/documents", json("POST", payload));
    console.log(`Created ${document.id} (version ${document.version})`);
    return;
  }

  if (command === "update") {
    const id = positionals[0];
    if (!id) throw new Error("update requires a note ID.");
    const expectedVersion = versionFlag(flags);
    if (flags.title === undefined && flags.file === undefined && flags.body === undefined) {
      throw new Error("update requires at least one of --title, --file, or --body.");
    }
    const { document: latest } = await request(`/api/documents/${encodeURIComponent(id)}`);
    if (latest.version !== expectedVersion) {
      const error = new Error(`Stale version: requested v${expectedVersion}, current is v${latest.version}. Read the note again before retrying.`);
      error.status = 409;
      throw error;
    }
    const title = flags.title ?? latest.title;
    const body = await bodyFrom(flags, latest.body);
    const payload = { expectedVersion, expectedHash: latest.contentHash, title, body };
    if (flags.folder !== undefined) payload.folderId = flags.folder === "root" ? null : flags.folder;
    const { document } = await request(`/api/documents/${encodeURIComponent(id)}`, json("PUT", payload));
    console.log(`Updated ${document.id} (version ${document.version})`);
    return;
  }

  if (command === "delete") {
    const id = positionals[0];
    if (!id) throw new Error("delete requires a note ID.");
    const expectedVersion = versionFlag(flags);
    const { document: latest } = await request(`/api/documents/${encodeURIComponent(id)}`);
    if (latest.version !== expectedVersion) {
      const error = new Error(`Stale version: requested v${expectedVersion}, current is v${latest.version}. Read the note again before retrying.`);
      error.status = 409;
      throw error;
    }
    await request(`/api/documents/${encodeURIComponent(id)}`, json("DELETE", { expectedVersion, expectedHash: latest.contentHash }));
    console.log(`Deleted ${id}`);
    return;
  }

  if (command === "move-document") {
    const id = positionals[0];
    if (!id) throw new Error("move-document requires a note ID.");
    if (flags.folder === undefined) throw new Error("move-document requires --folder ID|root.");
    const expectedVersion = versionFlag(flags);
    const { document: latest } = await request(`/api/documents/${encodeURIComponent(id)}`);
    if (latest.version !== expectedVersion) {
      const error = new Error(`Stale version: requested v${expectedVersion}, current is v${latest.version}. Read the note again before retrying.`);
      error.status = 409;
      throw error;
    }
    const folderId = flags.folder === "root" ? null : flags.folder;
    const { document } = await request(`/api/documents/${encodeURIComponent(id)}`, json("PUT", {
      expectedVersion,
      expectedHash: latest.contentHash,
      title: latest.title,
      body: latest.body,
      folderId,
    }));
    console.log(`Moved ${document.id} to ${folderId ?? "Unfiled"} (version ${document.version})`);
    return;
  }

  if (command === "folder") {
    const [action, id] = positionals;
    if (action === "list") {
      const { folders } = await request("/api/folders");
      const byId = new Map(folders.map((folder) => [folder.id, folder]));
      const children = new Map();
      for (const folder of folders) {
        const parent = folder.parentId && byId.has(folder.parentId) ? folder.parentId : null;
        const siblings = children.get(parent) ?? [];
        siblings.push(folder);
        children.set(parent, siblings);
      }
      for (const siblings of children.values()) siblings.sort((left, right) => left.name.localeCompare(right.name));
      const stack = [...(children.get(null) ?? [])].reverse().map((folder) => ({ folder, depth: 0 }));
      const visited = new Set();
      while (stack.length) {
        const { folder, depth } = stack.pop();
        if (visited.has(folder.id)) continue;
        visited.add(folder.id);
        console.log(`${"  ".repeat(depth)}${folder.name}  ${folder.id}  v${folder.version}  ${folder.documentCount} notes`);
        for (const child of [...(children.get(folder.id) ?? [])].reverse()) {
          stack.push({ folder: child, depth: depth + 1 });
        }
      }
      if (!folders.length) console.log("No folders found.");
      return;
    }

    if (action === "create") {
      if (!flags.name) throw new Error("folder create requires --name.");
      const payload = { name: flags.name };
      if (flags.parent !== undefined) payload.parentId = flags.parent === "root" ? null : flags.parent;
      const { folder } = await request("/api/folders", json("POST", payload));
      console.log(`Created folder ${folder.id} (version ${folder.version})`);
      return;
    }

    if (action === "rename" || action === "move") {
      if (!id) throw new Error(`folder ${action} requires a folder ID.`);
      const expectedVersion = versionFlag(flags);
      const payload = { expectedVersion };
      if (action === "rename") {
        if (!flags.name) throw new Error("folder rename requires --name.");
        payload.name = flags.name;
      } else {
        if (flags.parent === undefined) throw new Error("folder move requires --parent ID|root.");
        payload.parentId = flags.parent === "root" ? null : flags.parent;
      }
      const { folder } = await request(`/api/folders/${encodeURIComponent(id)}`, json("PUT", payload));
      console.log(`${action === "rename" ? "Renamed" : "Moved"} folder ${folder.id} (version ${folder.version})`);
      return;
    }

    if (action === "delete") {
      if (!id) throw new Error("folder delete requires a folder ID.");
      const expectedVersion = versionFlag(flags);
      await request(`/api/folders/${encodeURIComponent(id)}`, json("DELETE", { expectedVersion }));
      console.log(`Deleted empty folder ${id}`);
      return;
    }

    usage();
    throw new Error(`Unknown folder action: ${action ?? "(missing)"}`);
  }

  if (command === "vault") {
    if (positionals[0] !== "status") throw new Error("vault requires the status action.");
    const status = await request("/api/vault/status");
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  usage();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  if (error.status === 409) console.error("Conflict: no write was committed. Read the latest version and decide how to merge.");
  process.exitCode = 1;
});
