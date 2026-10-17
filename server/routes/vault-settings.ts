import type { Express } from "express";
import type { KnowledgeDatabase } from "../storage/database.js";
import { VaultStorageError } from "../storage/vault.js";
import type { VaultSettingsService } from "../storage/vault-settings.js";

export function registerVaultSettingsRoutes(app: Express, database: KnowledgeDatabase, vaultSettings: VaultSettingsService): void {
  app.get("/api/vault/status", (_request, response) => {
    if (!database.vault) {
      response.json({ mode: "sqlite", documentCount: Number((database.db.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number }).count) });
      return;
    }
    const snapshot = database.vault.snapshot();
    response.json({ mode: "filesystem", vaultId: snapshot.vaultId, documentCount: snapshot.documents.length, folderCount: snapshot.folders.length, sequence: snapshot.sequence });
  });

  app.get("/api/vault/settings", (_request, response) => {
    response.json({ settings: vaultSettings.getState() });
  });

  app.get("/api/vault/settings/directories", (request, response) => {
    response.json({ listing: vaultSettings.listDirectories(request.query.relativePath ?? "") });
  });

  const verifyVaultSettingsTarget = (relativePath: unknown) => {
    const result = vaultSettings.verify(relativePath);
    if (!database.vault && result.state === "empty") {
      const documentCount = Number((database.db.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number }).count);
      if (documentCount > 0) {
        throw new VaultStorageError("This SQLite library already contains notes. Complete the documented offline vault migration before selecting an empty folder.", "vault_migration_required", 409);
      }
    }
    return result;
  };

  app.post("/api/vault/settings/verify", (request, response) => {
    const result = verifyVaultSettingsTarget(request.body?.relativePath);
    response.json({ verified: true, path: result.absolutePath, state: result.state, relativePath: request.body?.relativePath ?? "" });
  });

  app.post("/api/vault/settings/selection", (request, response) => {
    verifyVaultSettingsTarget(request.body?.relativePath);
    response.json({ settings: vaultSettings.saveSelection(request.body?.relativePath) });
  });

  app.delete("/api/vault/settings/selection", (_request, response) => {
    response.json({ settings: vaultSettings.clearSelection() });
  });
}
