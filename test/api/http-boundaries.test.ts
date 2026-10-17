import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createApp } from "../../server/api.js";
import { closeDatabase, openDatabase } from "../../server/storage/database.js";

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "fieldnotes-http-boundaries-"));
const staticDirectory = path.join(temporaryRoot, "client");
mkdirSync(staticDirectory);
writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>fieldnotes-boundary-fixture</title>");
writeFileSync(path.join(staticDirectory, "fixture.txt"), "static-boundary-fixture");
const database = openDatabase(path.join(temporaryRoot, "data"), { seedDemo: false });
const app = createApp(database, staticDirectory);
const server = app.listen(0, "127.0.0.1");
const baseUrl = await new Promise<string>((resolve, reject) => {
  server.once("listening", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("Missing test server address."));
    resolve(`http://127.0.0.1:${address.port}`);
  });
  server.once("error", reject);
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeDatabase(database);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

test("malformed JSON and invalid document fields retain their distinct HTTP errors", async () => {
  for (const [body, code, message] of [
    ["{", "invalid_json", "Request body must be valid JSON."],
    [JSON.stringify({ title: "", body: "fixture" }), "invalid_request", "Title cannot be empty."],
  ]) {
    const response = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: code, message });
  }
});

test("unregistered API routes return JSON 404 instead of the SPA document", async () => {
  const response = await fetch(`${baseUrl}/api/nonexistent-boundary`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/u);
  assert.deepEqual(await response.json(), { error: "not_found", message: "API route not found." });
});

test("direct note URLs serve the SPA while existing static files retain their content", async () => {
  const response = await fetch(`${baseUrl}/notes/boundary-fixture`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/u);
  assert.match(await response.text(), /fieldnotes-boundary-fixture/u);

  const asset = await fetch(`${baseUrl}/fixture.txt`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "static-boundary-fixture");
});
