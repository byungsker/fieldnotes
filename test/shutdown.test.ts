import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { createApp } from "../server/api.js";
import { closeDatabase, openDatabase } from "../server/database.js";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const projectDirectory = path.resolve(import.meta.dirname, "..");

test("the HTTP drain guard rejects new writes on a still-open listener", { timeout: 8_000 }, async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "fieldnotes-drain-guard-test-"));
  const database = openDatabase(dataDir, { seedDemo: false });
  const app = createApp(database);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const events = await fetch(`${baseUrl}/api/events`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(events.status, 200);
    assert.ok(events.body);
    const reader = events.body.getReader();
    await reader.read();

    const beginShutdown = app.locals.beginShutdown as () => Promise<void>;
    const draining = beginShutdown();
    const blocked = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Rejected during drain", body: "" }),
    });
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).error, "server_shutting_down");

    let streamText = "";
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamText += decoder.decode(chunk.value);
    }
    assert.match(streamText, /event: server_shutdown/);
    await draining;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(database);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fieldnotes did not finish graceful shutdown in time.")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("SIGTERM closes SSE, rejects new work, drains an accepted write, and releases the database lock", { timeout: 15_000 }, async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "fieldnotes-shutdown-test-"));
  const child = spawn(process.execPath, ["--import", "tsx/esm", "server/index.ts"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      KB_DATA_DIR: dataDir,
      KB_HOST: "127.0.0.1",
      KB_PORT: "0",
      KB_SEED_DEMO_DATA: "false",
      KB_VAULT_DIR: "",
      KB_ALLOWED_TAILSCALE_LOGIN: "",
      KB_PUBLIC_ORIGIN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });

  let baseUrl: string | undefined;
  const deadline = Date.now() + 7_000;
  try {
    while (!baseUrl && Date.now() < deadline) {
      const match = output.match(/Fieldnotes API listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) baseUrl = `http://127.0.0.1:${match[1]}`;
      else if (child.exitCode !== null) throw new Error(`Isolated server exited early: ${stderr}`);
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(baseUrl, `Isolated server did not report its ephemeral port: ${stderr}`);

    const eventResponse = await fetch(`${baseUrl}/api/events`, { signal: AbortSignal.timeout(8_000) });
    assert.equal(eventResponse.status, 200);
    assert.ok(eventResponse.body);
    const eventReader = eventResponse.body.getReader();
    const decoder = new TextDecoder();
    const firstEventChunk = await eventReader.read();
    assert.equal(firstEventChunk.done, false);

    const writeResponse = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(`${baseUrl}/api/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      });
      request.once("error", reject);
      request.write('{"title":"Drained write","body":"pending');
      setTimeout(() => request.end('"}'), 250);
    });

    const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3_000) });
    assert.equal(health.status, 200);
    child.kill("SIGTERM");

    const eventChunks = [decoder.decode(firstEventChunk.value)];
    while (true) {
      const next = await eventReader.read();
      if (next.done) break;
      eventChunks.push(decoder.decode(next.value));
    }
    assert.match(eventChunks.join(""), /event: server_shutdown/);

    let blockedNewWrite = false;
    try {
      const rejected = await fetch(`${baseUrl}/api/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Must be rejected", body: "" }),
        signal: AbortSignal.timeout(2_000),
      });
      blockedNewWrite = rejected.status === 503;
    } catch {
      // server.close() stops accepting new connections before the drain completes.
      blockedNewWrite = true;
    }
    assert.equal(blockedNewWrite, true);

    const acceptedWrite = await writeResponse;
    assert.equal(acceptedWrite.status, 201, acceptedWrite.body);
    const exit = await waitForExit(child, 5_000);
    assert.equal(exit.code, 0, `Shutdown exited with signal ${exit.signal}; stderr: ${stderr}`);
    assert.equal(existsSync(path.join(dataDir, "server.lock")), false);

    const database = new DatabaseSync(path.join(dataDir, "knowledge.sqlite"), { readOnly: true });
    try {
      assert.equal((database.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check, "ok");
      assert.equal(Number((database.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number }).count), 1);
      const document = database.prepare("SELECT title, body FROM documents").get() as { title: string; body: string };
      assert.equal(document.title, "Drained write");
      assert.equal(document.body, "pending");
    } finally {
      database.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      try {
        await waitForExit(child, 2_000);
      } catch {
        child.kill("SIGKILL");
        await waitForExit(child, 2_000).catch(() => undefined);
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});
