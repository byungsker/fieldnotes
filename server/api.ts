import { existsSync } from "node:fs";
import path from "node:path";
import type { ErrorRequestHandler, Express, Request, Response } from "express";
import express from "express";
import type { ChangeRecord } from "./types.js";
import {
  createDocument,
  deleteDocument,
  exportDocuments,
  getBacklinks,
  getChangesAfter,
  getDocument,
  getLatestChangeSequence,
  getRecentChanges,
  importDocuments,
  listDocuments,
  MissingDocumentError,
  updateDocument,
  VersionConflictError,
  type ImportedDocument,
  type KnowledgeDatabase,
} from "./database.js";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 160;
const MAX_BODY_LENGTH = 250_000;
const MAX_IMPORT_FILES = 100;
const MAX_IMPORT_BYTES = 5_000_000;

class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

function sendError(response: Response, status: number, code: string, message: string, extra = {}): void {
  response.status(status).json({ error: code, message, ...extra });
}

function validateDocumentId(value: string): string {
  if (!ID_PATTERN.test(value)) throw new RequestValidationError("Note id must be a UUID.");
  return value;
}

function requestDocumentId(request: Request): string {
  const value = request.params.id;
  if (typeof value !== "string") throw new RequestValidationError("Note id must be a UUID.");
  return validateDocumentId(value);
}

function validateTitle(value: unknown): string {
  if (typeof value !== "string") throw new RequestValidationError("Title must be text.");
  const title = value.trim();
  if (!title) throw new RequestValidationError("Title cannot be empty.");
  if (title.length > MAX_TITLE_LENGTH) throw new RequestValidationError(`Title must be ${MAX_TITLE_LENGTH} characters or fewer.`);
  return title;
}

function validateBody(value: unknown): string {
  if (typeof value !== "string") throw new RequestValidationError("Markdown body must be text.");
  if (value.length > MAX_BODY_LENGTH) throw new RequestValidationError("Markdown body is too large (250 KB maximum).");
  return value;
}

function validateVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RequestValidationError("expectedVersion must be a positive integer.");
  }
  return version;
}

function validateSequence(value: unknown, label: string): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RequestValidationError(`${label} must be a non-negative integer.`);
  }
  return sequence;
}

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
    totalCharacters += title.length + body.length;
    if (totalCharacters > MAX_IMPORT_BYTES) throw new RequestValidationError("Import is too large (5 MB maximum).");
    return { title, body };
  });
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RequestValidationError("limit must be a positive integer.");
  return Math.min(limit, max);
}

function currentDocument(database: KnowledgeDatabase, request: Request, response: Response): boolean {
  const id = requestDocumentId(request);
  const document = getDocument(database.db, id);
  if (!document) {
    sendError(response, 404, "not_found", "Note not found.");
    return false;
  }
  response.json({ document });
  return true;
}

export function createApp(database: KnowledgeDatabase, staticDirectory?: string): Express {
  const app = express();
  const resolvedStaticDirectory = staticDirectory ? path.resolve(staticDirectory) : undefined;
  const staticIndex = resolvedStaticDirectory ? path.join(resolvedStaticDirectory, "index.html") : undefined;

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );

    const origin = request.get("origin");
    if (origin) {
      const expectedOrigin = `${request.protocol}://${request.get("host")}`;
      const configuredPublicOrigin = process.env.KB_PUBLIC_ORIGIN?.trim().replace(/\/$/, "");
      if (origin !== expectedOrigin && origin !== configuredPublicOrigin) {
        sendError(response, 403, "origin_rejected", "Cross-origin requests are not allowed.");
        return;
      }
    }
    next();
  });

  app.use(express.json({ limit: "8mb", strict: true }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, schemaVersion: Number((database.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) });
  });

  app.get("/api/documents", (request, response) => {
    response.json({ documents: listDocuments(database.db, String(request.query.q ?? "")) });
  });

  app.post("/api/documents", (request, response) => {
    const title = validateTitle(request.body?.title);
    const body = validateBody(request.body?.body ?? "");
    const document = createDocument(database, title, body);
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
    const document = updateDocument(database, id, expectedVersion, title, body);
    response.json({ document });
  });

  app.delete("/api/documents/:id", (request, response) => {
    const id = requestDocumentId(request);
    const expectedVersion = validateVersion(request.body?.expectedVersion);
    deleteDocument(database, id, expectedVersion);
    response.status(204).end();
  });

  app.get("/api/backlinks/:id", (request, response) => {
    const id = requestDocumentId(request);
    response.json({ backlinks: getBacklinks(database.db, id) });
  });

  app.get("/api/changes", (request, response) => {
    const after = validateSequence(request.query.after ?? 0, "after");
    const changes = getChangesAfter(database.db, after);
    response.json({ changes, highWatermark: getLatestChangeSequence(database.db) });
  });

  app.get("/api/changes/recent", (request, response) => {
    const limit = parseLimit(request.query.limit, 16, 100);
    response.json({ changes: getRecentChanges(database.db, limit) });
  });

  app.get("/api/events", (request, response) => {
    const headerValue = request.get("last-event-id");
    const after = validateSequence(headerValue ?? request.query.after ?? 0, "after");
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    response.write("retry: 1500\n\n");

    let lastSent = after;
    const send = (change: ChangeRecord) => {
      if (change.seq <= lastSent || response.writableEnded) return;
      response.write(`id: ${change.seq}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`);
      lastSent = change.seq;
    };
    const onChange = (change: Parameters<typeof send>[0]) => send(change);
    database.changes.on("change", onChange);

    // The listener is attached before the synchronous database read, so writes cannot
    // fall between replay and subscription on Node's event loop.
    for (const change of getChangesAfter(database.db, after)) send(change);
    response.write(`event: ready\ndata: ${JSON.stringify({ highWatermark: getLatestChangeSequence(database.db) })}\n\n`);

    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      database.changes.off("change", onChange);
    });
  });

  app.post("/api/import", (request, response) => {
    const documents = validateImport(request.body?.documents);
    response.status(201).json({ documents: importDocuments(database, documents) });
  });

  app.get("/api/export", (_request, response) => {
    const exportedAt = new Date().toISOString();
    response.setHeader("Content-Disposition", `attachment; filename="fieldnotes-${exportedAt.slice(0, 10)}.json"`);
    response.json({ format: "fieldnotes-export", schemaVersion: 1, exportedAt, documents: exportDocuments(database.db) });
  });

  app.use("/api", (_request, response) => {
    sendError(response, 404, "not_found", "API route not found.");
  });

  if (resolvedStaticDirectory && staticIndex && existsSync(staticIndex)) {
    app.use(express.static(resolvedStaticDirectory, { index: false, fallthrough: true }));
    app.use((request, response, next) => {
      if (request.method === "GET" && !request.path.startsWith("/api/")) {
        response.sendFile(staticIndex, (error) => {
          if (error) next(error);
        });
        return;
      }
      next();
    });
  }

  const errors: ErrorRequestHandler = (error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof RequestValidationError) {
      sendError(response, 400, "invalid_request", error.message);
      return;
    }
    if (error instanceof VersionConflictError) {
      sendError(response, 409, "version_conflict", error.message, { currentVersion: error.currentVersion });
      return;
    }
    if (error instanceof MissingDocumentError) {
      sendError(response, 404, "not_found", error.message);
      return;
    }
    const bodyError = error as { type?: string; status?: number; message?: string };
    if (bodyError.type === "entity.too.large") {
      sendError(response, 413, "payload_too_large", "Request body is too large.");
      return;
    }
    if (bodyError.status === 400) {
      sendError(response, 400, "invalid_json", "Request body must be valid JSON.");
      return;
    }
    console.error("Request failed:", error);
    sendError(response, 500, "internal_error", "The local service could not complete this request.");
  };
  app.use(errors);
  return app;
}
