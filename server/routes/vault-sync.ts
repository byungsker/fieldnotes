import type { Express } from "express";
import { getLatestChangeSequence, reconcileVault, type KnowledgeDatabase } from "../storage/database.js";

export function registerVaultSyncRoutes(app: Express, database: KnowledgeDatabase): void {
  app.post("/api/vault/sync", (_request, response) => {
    if (!database.vault) {
      response.json({ enabled: false, changed: false, changes: 0, sequence: getLatestChangeSequence(database.db) });
      return;
    }
    response.json({ enabled: true, ...reconcileVault(database) });
  });
}
