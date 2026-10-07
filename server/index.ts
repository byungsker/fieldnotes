import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, openDatabase, startVaultMonitor } from "./database.js";
import { createApp } from "./api.js";

const isDevelopment = process.argv.includes("--dev");
const host = process.env.KB_HOST ?? "127.0.0.1";
const port = Number(process.env.KB_PORT ?? (isDevelopment ? 4178 : 4177));
const dataDir = path.resolve(process.env.KB_DATA_DIR ?? "./data");
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (!loopbackHosts.has(host)) {
  throw new Error("Remote binding is disabled in this MVP. Add and verify an identity-aware auth layer before changing KB_HOST.");
}

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const lockPath = path.join(dataDir, "server.lock");
if (existsSync(lockPath)) {
  let lock: { pid?: number };
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
  } catch {
    throw new Error(`Cannot read ${lockPath}; inspect it before starting another server.`);
  }
  if (!Number.isInteger(lock.pid) || !lock.pid || lock.pid < 1) {
    throw new Error(`Invalid server lock at ${lockPath}; inspect it before starting another server.`);
  }
  try {
    process.kill(lock.pid, 0);
    throw new Error(`Fieldnotes server ${lock.pid} is already running for ${dataDir}.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already running")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw new Error(`Cannot verify whether Fieldnotes server ${lock.pid} is running.`, { cause: error });
    }
    unlinkSync(lockPath);
  }
}
const lockDescriptor = openSync(lockPath, "wx", 0o600);
writeFileSync(lockDescriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
closeSync(lockDescriptor);

let database: ReturnType<typeof openDatabase>;
try {
  database = openDatabase(dataDir);
} catch (error) {
  unlinkSync(lockPath);
  throw error;
}
const staticDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client");
const app = createApp(database, isDevelopment ? undefined : staticDirectory);
const stopVaultMonitor = startVaultMonitor(database);
const server = app.listen(port, host, () => {
  const address = server.address();
  const listeningPort = address && typeof address !== "string" ? address.port : port;
  console.log(`Fieldnotes API listening on http://${host}:${listeningPort}`);
  console.log(database.vault ? `Markdown vault: ${database.vault.rootDir}` : `SQLite data directory: ${dataDir}`);
});

server.on("error", (error) => {
  stopVaultMonitor();
  closeDatabase(database);
  if (existsSync(lockPath)) unlinkSync(lockPath);
  console.error("Could not start Fieldnotes:", error);
  process.exitCode = 1;
});

let shutdownPromise: Promise<void> | undefined;
function shutdown(): void {
  if (shutdownPromise) return;
  stopVaultMonitor();
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const beginShutdown = app.locals.beginShutdown as (() => Promise<void>) | undefined;
  if (!beginShutdown) {
    console.error("Fieldnotes HTTP drain controller is missing; leaving the database open.");
    process.exitCode = 1;
    return;
  }
  shutdownPromise = (async () => {
    await beginShutdown();
    server.closeAllConnections();
    await serverClosed;
    closeDatabase(database);
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
        if (lock.pid === process.pid) unlinkSync(lockPath);
        else console.error("Fieldnotes shutdown left a lock owned by another process untouched.");
      } catch (error) {
        console.error("Could not verify the Fieldnotes server lock during shutdown:", error);
      }
    }
  })().then(() => {
    process.exitCode = 0;
  }).catch((error: unknown) => {
    console.error("Fieldnotes graceful shutdown failed; the process remains alive for recovery:", error);
    process.exitCode = 1;
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
