import type { Express, Request, Response } from "express";
import {
  createDocument,
  deleteDocument,
  exportDocuments,
  getBacklinks,
  importDocuments,
  listDocuments,
  listFolders,
  readCurrentDocument,
  updateDocument,
  type ImportedDocument,
  type KnowledgeDatabase,
} from "../storage/database.js";
import { sendError } from "../http/errors.js";
import {
  RequestValidationError,
  requestDocumentId,
  validateBody,
  validateDocumentId,
  validateFolderId,
  validateFolderParent,
  validateHash,
  validateTitle,
  validateVersion,
} from "../http/validation.js";

const MAX_IMPORT_FILES = 100;
const MAX_IMPORT_BYTES = 5_000_000;

function validateImport(value: unknown): ImportedDocument[] {
  if (!Array.isArray(value)) throw new RequestValidationError("documents must be an array.");
  if (value.length < 1 || value.length > MAX_IMPORT_FILES) {
    throw new RequestValidationError(`Import must contain between 1 and ${MAX_IMPORT_FILES} Markdown files.`);
  }
  let totalCharacters = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new RequestValidationError(`Import item ${index + 1} is invalid.`);
    const record = item as Record<string, unknown>;
    const title = validateTitle(record.title);
    const body = validateBody(record.body);
    const folderId = record.folderId === undefined ? null : validateFolderParent(record.folderId);
    totalCharacters += title.length + body.length;
    if (totalCharacters > MAX_IMPORT_BYTES) throw new RequestValidationError("Import is too large (5 MB maximum).");
    return { title, body, folderId };
  });
}

function currentDocument(database: KnowledgeDatabase, request: Request, response: Response): boolean {
  const id = requestDocumentId(request);
  const document = readCurrentDocument(database, id);
  if (!document) {
    sendError(response, 404, "not_found", "Note not found.");
    return false;
  }
  response.json({ document });
  return true;
}

export function registerDocumentRoutes(app: Express, database: KnowledgeDatabase): void {
  app.get("/api/documents", (request, response) => {
    const rawFolderId = request.query.folderId;
    const folderId = rawFolderId === undefined
      ? undefined
      : rawFolderId === "root"
        ? null
        : validateFolderId(String(rawFolderId));
    response.json({ documents: listDocuments(database.db, String(request.query.q ?? ""), folderId) });
  });

  app.post("/api/documents", (request, response) => {
    const title = validateTitle(request.body?.title);
    const body = validateBody(request.body?.body ?? "");
    const folderId = request.body?.folderId === undefined ? null : validateFolderParent(request.body.folderId);
    const requestedId = request.body?.id === undefined ? undefined : validateDocumentId(request.body.id);
    const document = createDocument(database, title, body, folderId, requestedId);
    response.status(201).json({ document });
  });

  app.get("/api/documents/:id", (request, response) => {
    currentDocument(database, request, response);
  });

  app.put("/api/documents/:id", (request, response) => {
    const id = requestDocumentId(request);
    const expectedVersion = validateVersion(request.body?.expectedVersion);
    const title = validateTitle(request.body?.title);
    const body = validateBody(request.body?.body);
    const expectedHash = validateHash(request.body?.expectedHash);
    const folderId = Object.hasOwn(request.body ?? {}, "folderId")
      ? validateFolderParent(request.body.folderId)
      : undefined;
    const document = updateDocument(database, id, expectedVersion, title, body, folderId, expectedHash);
    response.json({ document });
  });

  app.delete("/api/documents/:id", (request, response) => {
    const id = requestDocumentId(request);
    const expectedVersion = validateVersion(request.body?.expectedVersion);
    const expectedHash = validateHash(request.body?.expectedHash);
    deleteDocument(database, id, expectedVersion, expectedHash);
    response.status(204).end();
  });

  app.get("/api/backlinks/:id", (request, response) => {
    const id = requestDocumentId(request);
    response.json({ backlinks: getBacklinks(database.db, id) });
  });

  app.post("/api/import", (request, response) => {
    const documents = validateImport(request.body?.documents);
    response.status(201).json({ documents: importDocuments(database, documents) });
  });

  app.get("/api/export", (_request, response) => {
    const exportedAt = new Date().toISOString();
    response.setHeader("Content-Disposition", `attachment; filename="fieldnotes-${exportedAt.slice(0, 10)}.json"`);
    response.json({ format: "fieldnotes-export", schemaVersion: 3, exportedAt, folders: listFolders(database.db), documents: exportDocuments(database.db) });
  });
}
