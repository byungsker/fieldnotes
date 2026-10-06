import path from "node:path";
import { closeDatabase, openDatabase } from "../server/database.js";

const dataDir = path.resolve(process.env.KB_DATA_DIR ?? "./data");
const database = openDatabase(dataDir);
try {
  const version = Number(database.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  console.log(`Database schema is current (version ${version}) at ${dataDir}.`);
} finally {
  closeDatabase(database);
}
