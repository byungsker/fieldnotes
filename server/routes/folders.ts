import type { Express } from "express";
import { createFolder, deleteFolder, getFolder, listFolders, updateFolder, type KnowledgeDatabase } from "../storage/database.js";
import { sendError } from "../http/errors.js";
import { RequestValidationError, requestFolderId, validateFolderName, validateFolderParent, validateVersion } from "../http/validation.js";

export function registerFolderRoutes(app: Express, database: KnowledgeDatabase): void {
  app.get("/api/folders", (_request, response) => {
    response.json({ folders: listFolders(database.db) });
  });

  app.post("/api/folders", (request, response) => {
    const name = validateFolderName(request.body?.name);
    const parentId = request.body?.parentId === undefined ? null : validateFolderParent(request.body.parentId);
    const folder = createFolder(database, name, parentId);
    response.status(201).json({ folder });
  });

  app.get("/api/folders/:id", (request, response) => {
    const folder = getFolder(database.db, requestFolderId(request));
    if (!folder) {
      sendError(response, 404, "not_found", "Folder not found.");
      return;
    }
    response.json({ folder });
  });

  app.put("/api/folders/:id", (request, response) => {
    const id = requestFolderId(request);
    const expectedVersion = validateVersion(request.body?.expectedVersion);
    const updates: { name?: string; parentId?: string | null } = {};
    if (Object.hasOwn(request.body ?? {}, "name")) updates.name = validateFolderName(request.body.name);
    if (Object.hasOwn(request.body ?? {}, "parentId")) updates.parentId = validateFolderParent(request.body.parentId);
    if (!Object.keys(updates).length) throw new RequestValidationError("Provide a folder name or parentId to update.");
    response.json({ folder: updateFolder(database, id, expectedVersion, updates) });
  });

  app.delete("/api/folders/:id", (request, response) => {
    const id = requestFolderId(request);
    const expectedVersion = validateVersion(request.body?.expectedVersion);
    deleteFolder(database, id, expectedVersion);
    response.status(204).end();
  });
}
