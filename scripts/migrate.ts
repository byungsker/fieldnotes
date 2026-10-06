import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { closeDatabase, openDatabase } from "../server/database.js";

const dataDir = path.resolve(process.env.KB_DATA_DIR ?? "./data");
const lockPath = path.join(dataDir, "server.lock");
if (existsSync(lockPath)) {
  let lock: { pid?: number };
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
  } catch (error) {
    throw new Error(`Cannot verify ${lockPath}. Inspect it and stop Fieldnotes before migrating.`, { cause: error });
  }
  if (!Number.isInteger(lock.pid) || !lock.pid || lock.pid < 1) {
    throw new Error(`Invalid server lock at ${lockPath}; inspect it before migrating.`);
  }
  try {
    process.kill(lock.pid, 0);
    throw new Error(`Fieldnotes server ${lock.pid} is running. Stop it before an explicit migration.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("is running")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw new Error(`Cannot verify whether Fieldnotes server ${lock.pid} is running.`, { cause: error });
    }
    throw new Error(`Stale server lock at ${lockPath}; inspect it and confirm the server is stopped before migrating.`, { cause: error });
  }
}
const database = openDatabase(dataDir);
try {
  const version = Number(database.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  console.log(`Database schema is current (version ${version}) at ${dataDir}.`);
} finally {
  closeDatabase(database);
}
