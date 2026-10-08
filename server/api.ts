import { existsSync } from "node:fs";
import path from "node:path";
import type { ErrorRequestHandler, Express, Request, Response } from "express";
import express from "express";
import { BookmarkMetadataFetchError, fetchBookmarkMetadata, UnsafeBookmarkUrlError } from "./bookmark-metadata.js";
import type { ChangeRecord } from "./types.js";
import {
  createDocument,
  createFolder,
  deleteDocument,
  deleteFolder,
  exportDocuments,
  getFolder,
  getBacklinks,
  getChangesAfter,
  getDocument,
  getLatestChangeSequence,
  getRecentChanges,
  importDocuments,
  listDocuments,
  listFolders,
  reconcileVault,
  DuplicateFolderNameError,
  FolderCycleError,
  FolderNotEmptyError,
  MissingFolderError,
  MissingDocumentError,
  updateFolder,
  updateDocument,
  VersionConflictError,
  type ImportedDocument,
  type KnowledgeDatabase,
} from "./database.js";
import { VaultStorageError } from "./vault.js";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 160;
const MAX_FOLDER_NAME_LENGTH = 120;
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

function normalizedLogin(value: string | undefined): string | undefined {
  const login = value?.trim().toLowerCase();
  return login || undefined;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || Boolean(address?.startsWith("::ffff:127."));
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

function validateFolderId(value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new RequestValidationError("Folder id must be a UUID.");
  }
  return value;
}

function requestFolderId(request: Request): string {
  return validateFolderId(request.params.id);
}

function validateFolderName(value: unknown): string {
  if (typeof value !== "string") throw new RequestValidationError("Folder name must be text.");
  const name = value.trim();
  if (!name) throw new RequestValidationError("Folder name cannot be empty.");
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    throw new RequestValidationError(`Folder name must be ${MAX_FOLDER_NAME_LENGTH} characters or fewer.`);
  }
  if (Buffer.byteLength(name, "utf8") > 200) throw new RequestValidationError("Folder names must fit within 200 UTF-8 bytes on disk.");
  const hasControlCharacter = [...name].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  const normalizedName = name.normalize("NFC");
  const portableNameKey = normalizedName.normalize("NFD").toLowerCase();
  if (name === "." || name === ".." || portableNameKey === ".fieldnotes" || portableNameKey.startsWith(".fieldnotes-tmp-") || name.endsWith(".") || name.endsWith(" ") || name.includes("/") || name.includes("\\") || hasControlCharacter) {
    throw new RequestValidationError("Folder names cannot contain path separators or control characters.");
  }
  return normalizedName;
}

function validateFolderParent(value: unknown): string | null {
  if (value === null) return null;
  return validateFolderId(value);
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

function validateHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new RequestValidationError("expectedHash must be a SHA-256 hex digest.");
  }
  return value.toLowerCase();
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
    const folderId = record.folderId === undefined ? null : validateFolderParent(record.folderId);
    totalCharacters += title.length + body.length;
    if (totalCharacters > MAX_IMPORT_BYTES) throw new RequestValidationError("Import is too large (5 MB maximum).");
    return { title, body, folderId };
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
  const allowedTailscaleLogin = normalizedLogin(process.env.KB_ALLOWED_TAILSCALE_LOGIN);
  const configuredPublicOrigin = process.env.KB_PUBLIC_ORIGIN?.trim().replace(/\/$/, "") || undefined;
  const activeResponses = new Set<Promise<void>>();
  const eventStreams = new Set<() => void>();
  let nextEventStreamId = 1;
  let draining = false;
  let drainPromise: Promise<void> | undefined;

  const trackResponse = (response: Response): void => {
    let settled = false;
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const finish = () => {
      if (settled) return;
      settled = true;
      activeResponses.delete(completion);
      resolveCompletion();
    };
    activeResponses.add(completion);
    response.once("finish", finish);
    response.once("close", finish);
  };

  app.locals.beginShutdown = (): Promise<void> => {
    if (drainPromise) return drainPromise;
    draining = true;
    const pendingResponses = [...activeResponses];
    for (const close of [...eventStreams]) close();
    drainPromise = Promise.all(pendingResponses).then(() => undefined);
    return drainPromise;
  };

  if (Boolean(allowedTailscaleLogin) !== Boolean(configuredPublicOrigin)) {
    throw new Error("Set KB_ALLOWED_TAILSCALE_LOGIN and KB_PUBLIC_ORIGIN together; an origin check alone is not authentication.");
  }
  if (configuredPublicOrigin) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(configuredPublicOrigin);
    } catch (error) {
      throw new Error("KB_PUBLIC_ORIGIN must be a valid HTTPS origin.", { cause: error });
    }
    if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== configuredPublicOrigin) {
      throw new Error("KB_PUBLIC_ORIGIN must be an HTTPS origin without a path, query, or fragment.");
    }
  }

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );

    if (allowedTailscaleLogin) {
      // Tailscale Serve is the trusted proxy: it removes client-supplied identity headers
      // and injects the authenticated login. Keep this server loopback-only and do not
      // enable Express trust proxy; local processes on this Mac remain inside the trust boundary.
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        sendError(response, 403, "untrusted_proxy", "Requests must arrive through the loopback identity proxy.");
        return;
      }
      const requestLogin = normalizedLogin(request.get("Tailscale-User-Login"));
      if (!requestLogin) {
        sendError(response, 401, "identity_required", "A Tailscale Serve identity is required.");
        return;
      }
      if (requestLogin !== allowedTailscaleLogin) {
        sendError(response, 403, "identity_rejected", "This Tailscale identity is not allowed.");
        return;
      }
    }

    const origin = request.get("origin");
    if (origin) {
      const expectedOrigin = `${request.protocol}://${request.get("host")}`;
      if (origin !== expectedOrigin && origin !== configuredPublicOrigin) {
        sendError(response, 403, "origin_rejected", "Cross-origin requests are not allowed.");
        return;
      }
    }
    if (draining) {
      response.setHeader("Connection", "close");
      sendError(response, 503, "server_shutting_down", "Fieldnotes is draining existing requests.");
      return;
    }
    trackResponse(response);
    next();
  });

  app.use(express.json({ limit: "8mb", strict: true }));

  app.use("/api", (request, response, next) => {
    try {
      reconcileVault(database);
      next();
    } catch (error) {
      if (error instanceof VaultStorageError) {
        sendError(response, error.status, error.code, error.message);
        return;
      }
      next(error);
    }
  });

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      schemaVersion: Number((database.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
      storageMode: database.vault ? "filesystem" : "sqlite",
    });
  });

  app.get("/api/vault/status", (_request, response) => {
    if (!database.vault) {
      response.json({ mode: "sqlite", documentCount: Number((database.db.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number }).count) });
      return;
    }
    const snapshot = database.vault.snapshot();
    response.json({ mode: "filesystem", vaultId: snapshot.vaultId, documentCount: snapshot.documents.length, folderCount: snapshot.folders.length, sequence: snapshot.sequence });
  });

  app.get("/api/bookmarks/metadata", async (request, response) => {
    if (typeof request.query.url !== "string") throw new RequestValidationError("A single bookmark URL is required.");
    const metadata = await fetchBookmarkMetadata(request.query.url);
    response.json({ metadata });
  });

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
    const streamId = nextEventStreamId++;
    const startedAt = Date.now();
    let heartbeatCount = 0;
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

    const heartbeat = setInterval(() => {
      if (!response.writableEnded && !response.destroyed) {
        response.write(": keep-alive\n\n");
        heartbeatCount += 1;
      }
    }, 20_000);
    heartbeat.unref();
    let cleaned = false;
    let shutdownInitiated = false;
    let closeForShutdown: () => void = () => undefined;
    const cleanup = (reason: "server_shutdown" | "finished" | "client_closed") => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      database.changes.off("change", onChange);
      eventStreams.delete(closeForShutdown);
      console.info("[Fieldnotes SSE] stream closed", JSON.stringify({
        streamId,
        reason,
        durationMs: Date.now() - startedAt,
        lastSequence: lastSent,
        heartbeatCount,
        activeStreams: eventStreams.size,
      }));
    };
    closeForShutdown = () => {
      shutdownInitiated = true;
      try {
        if (!response.writableEnded && !response.destroyed) {
          response.write("event: server_shutdown\ndata: {\"reconnect\":true}\n\n");
          response.end();
        }
      } finally {
        cleanup("server_shutdown");
      }
    };
    eventStreams.add(closeForShutdown);
    console.info("[Fieldnotes SSE] stream opened", JSON.stringify({ streamId, cursor: after, activeStreams: eventStreams.size }));
    response.once("finish", () => cleanup(shutdownInitiated ? "server_shutdown" : "finished"));
    response.once("close", () => cleanup(shutdownInitiated ? "server_shutdown" : "client_closed"));
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
    if (error instanceof UnsafeBookmarkUrlError) {
      sendError(response, 400, "invalid_bookmark_url", error.message);
      return;
    }
    if (error instanceof BookmarkMetadataFetchError) {
      sendError(response, 502, "bookmark_metadata_unavailable", error.message);
      return;
    }
    if (error instanceof VersionConflictError) {
      sendError(response, 409, "version_conflict", error.message, {
        currentVersion: error.currentVersion,
        ...(error.currentHash ? { currentHash: error.currentHash } : {}),
      });
      return;
    }
    if (error instanceof VaultStorageError) {
      sendError(response, error.status, error.code, error.message);
      return;
    }
    if (error instanceof MissingDocumentError) {
      sendError(response, 404, "not_found", error.message);
      return;
    }
    if (error instanceof MissingFolderError) {
      sendError(response, 404, "not_found", error.message);
      return;
    }
    if (error instanceof FolderNotEmptyError) {
      sendError(response, 409, "folder_not_empty", error.message);
      return;
    }
    if (error instanceof FolderCycleError) {
      sendError(response, 409, "folder_cycle", error.message);
      return;
    }
    if (error instanceof DuplicateFolderNameError) {
      sendError(response, 409, "duplicate_folder", error.message);
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
