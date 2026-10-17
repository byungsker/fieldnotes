import type { DatabaseSync } from "node:sqlite";
import type { EventEmitter } from "node:events";
import type { FileVault } from "../vault.js";

export type SqlRow = Record<string, string | number | null>;

export type DatabaseOptions = { seedDemo?: boolean; vaultDir?: string; vaultPathAllowRoot?: string };

export type KnowledgeDatabase = {
  db: DatabaseSync;
  dataDir: string;
  dbPath: string;
  vault?: FileVault;
  changes: EventEmitter;
  vaultIndexReady?: boolean;
  vaultIndexedSequence?: number;
};
