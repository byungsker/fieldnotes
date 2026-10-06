#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const baseUrl = (process.env.KB_BASE_URL ?? "http://127.0.0.1:4177").replace(/\/$/, "");
const [command, ...arguments_] = process.argv.slice(2);

function usage() {
  console.log(`Fieldnotes CLI — use the same local API as the web app

Usage:
  node scripts/kb.mjs list [--query TEXT]
  node scripts/kb.mjs search TEXT
  node scripts/kb.mjs read ID
  node scripts/kb.mjs create --title TITLE [--file PATH | --body TEXT]
  node scripts/kb.mjs update ID --version N [--title TITLE] [--file PATH | --body TEXT]
  node scripts/kb.mjs delete ID --version N

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
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message ?? `Request failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.code = body.error;
    error.currentVersion = body.currentVersion;
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

function printDocuments(documents) {
  if (!documents.length) {
    console.log("No notes found.");
    return;
  }
  for (const note of documents) {
    const excerpt = note.excerpt ? ` — ${note.excerpt}` : "";
    console.log(`${note.id}  v${note.version}  ${note.title}${excerpt}`);
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
    console.log(JSON.stringify({ id: document.id, title: document.title, version: document.version, updatedAt: document.updatedAt }, null, 2));
    console.log("\n--- Markdown ---\n");
    console.log(document.body);
    return;
  }

  if (command === "create") {
    if (!flags.title) throw new Error("create requires --title.");
    const body = await bodyFrom(flags);
    const { document } = await request("/api/documents", json("POST", { title: flags.title, body }));
    console.log(`Created ${document.id} (version ${document.version})`);
    return;
  }

  if (command === "update") {
    const id = positionals[0];
    if (!id) throw new Error("update requires a note ID.");
    if (!flags.version) throw new Error("update requires --version from the last read.");
    const expectedVersion = Number(flags.version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("--version must be a positive integer.");
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
    const { document } = await request(`/api/documents/${encodeURIComponent(id)}`, json("PUT", { expectedVersion, title, body }));
    console.log(`Updated ${document.id} (version ${document.version})`);
    return;
  }

  if (command === "delete") {
    const id = positionals[0];
    if (!id) throw new Error("delete requires a note ID.");
    if (!flags.version) throw new Error("delete requires --version from the last read.");
    const expectedVersion = Number(flags.version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("--version must be a positive integer.");
    await request(`/api/documents/${encodeURIComponent(id)}`, json("DELETE", { expectedVersion }));
    console.log(`Deleted ${id}`);
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
