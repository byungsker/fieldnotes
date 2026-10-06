import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, openDatabase } from "./database.js";
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
const server = app.listen(port, host, () => {
  console.log(`Fieldnotes API listening on http://${host}:${port}`);
  console.log(`SQLite data directory: ${dataDir}`);
});

server.on("error", (error) => {
  closeDatabase(database);
  if (existsSync(lockPath)) unlinkSync(lockPath);
  console.error("Could not start Fieldnotes:", error);
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    closeDatabase(database);
    if (existsSync(lockPath)) unlinkSync(lockPath);
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
