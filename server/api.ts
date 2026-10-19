import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import express, { type Express, type Response } from "express";
import { getChangesAfter, getLatestChangeSequence, getRecentChanges, type KnowledgeDatabase } from "./storage/database.js";
import { VaultSettingsService } from "./storage/vault-settings.js";
import type { ChangeRecord } from "./storage/types.js";
import { errors, sendError } from "./http/errors.js";
import { RequestValidationError } from "./http/validation.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerFolderRoutes } from "./routes/folders.js";
import { registerVaultSettingsRoutes } from "./routes/vault-settings.js";
import { registerVaultSyncRoutes } from "./routes/vault-sync.js";
import { registerBookmarkRoutes } from "./routes/bookmarks.js";
import { registerVisualizationRoutes } from "./routes/visualizations.js";

function normalizedLogin(value: string | undefined): string | undefined {
  const login = value?.trim().toLowerCase();
  return login || undefined;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || Boolean(address?.startsWith("::ffff:127."));
}

function validateSequence(value: unknown, label: string): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RequestValidationError(`${label} must be a non-negative integer.`);
  }
  return sequence;
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RequestValidationError("limit must be a positive integer.");
  return Math.min(limit, max);
}

export function createApp(database: KnowledgeDatabase, staticDirectory?: string, adapters: { vaultSettings?: { documentsRoot?: string; configuredVaultPath?: string | null } } = {}): Express {
  const app = express();
  const resolvedStaticDirectory = staticDirectory ? path.resolve(staticDirectory) : undefined;
  const staticIndex = resolvedStaticDirectory ? path.join(resolvedStaticDirectory, "index.html") : undefined;
  const allowedTailscaleLogin = normalizedLogin(process.env.KB_ALLOWED_TAILSCALE_LOGIN);
  const configuredPublicOrigin = process.env.KB_PUBLIC_ORIGIN?.trim().replace(/\/$/, "") || undefined;
  const configuredVaultPath = Object.hasOwn(adapters.vaultSettings ?? {}, "configuredVaultPath")
    ? adapters.vaultSettings?.configuredVaultPath ?? null
    : process.env.KB_VAULT_DIR?.trim() ? path.resolve(process.env.KB_VAULT_DIR) : null;
  const vaultSettings = new VaultSettingsService(
    database.dataDir,
    database.vault?.rootDir ?? null,
    adapters.vaultSettings?.documentsRoot ?? path.join(homedir(), "Documents"),
    configuredVaultPath,
  );
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
    const visualizationRunner = request.path === "/visualization-runner.html";
    const visualizationRunnerScript = request.path === "/visualization-runner.js";
    response.setHeader("Referrer-Policy", visualizationRunner ? "no-referrer" : "strict-origin-when-cross-origin");
    response.setHeader("X-Frame-Options", visualizationRunner ? "SAMEORIGIN" : "DENY");
    if (visualizationRunnerScript) {
      response.setHeader("Access-Control-Allow-Origin", "null");
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    }
    response.setHeader("Content-Security-Policy", visualizationRunner
      ? "default-src 'none'; script-src 'sha256-WGYVWEolnLfQu4Rw/WBG2QUL3iHWfiqap5DG+90XptI=' blob:; script-src-elem 'sha256-WGYVWEolnLfQu4Rw/WBG2QUL3iHWfiqap5DG+90XptI=' blob:; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'; frame-ancestors 'self'; worker-src blob:"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");

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
      const sandboxRunnerScript = origin === "null"
        && request.method === "GET"
        && request.path === "/visualization-runner.js";
      if (origin !== expectedOrigin && origin !== configuredPublicOrigin && !sandboxRunnerScript) {
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

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      schemaVersion: Number((database.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
      storageMode: database.vault ? "filesystem" : "sqlite",
    });
  });

  registerVaultSettingsRoutes(app, database, vaultSettings);

  registerVaultSyncRoutes(app, database);

  registerBookmarkRoutes(app);

  registerDocumentRoutes(app, database);

  registerVisualizationRoutes(app, database);

  registerFolderRoutes(app, database);

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

  app.use(errors);
  return app;
}
