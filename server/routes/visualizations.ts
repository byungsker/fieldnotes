import { createHash } from "node:crypto";
import type { Express } from "express";
import {
  createDocument,
  listTrashedDocuments,
  MissingDocumentError,
  restoreTrashedDocument,
  readCurrentDocument,
  trashDocument,
  updateDocument,
  VersionConflictError,
  type KnowledgeDatabase,
} from "../storage/database.js";
import { queryVisualizationNotes, validateVisualizationQuery } from "../visualization/query.js";
import { MAX_VIEW_TRASH_BYTES, MAX_VIEW_TRASH_CANDIDATES } from "../view-query-limits.js";
import { parseFrontmatter, patchFrontmatter, serializeFrontmatter } from "../visualization/frontmatter.js";
import {
  extractFrontmatterImageFields,
  fetchRemoteVisualizationImage,
  MAX_VISUALIZATION_IMAGE_BYTES,
  resolveFrontmatterImageSource,
  resolveReferencedLocalImagePath,
  validateLocalImage,
} from "../visualization/assets.js";
import type { VisualizationAction, VisualizationValue } from "../../shared/visualization.js";
import { sendError } from "../http/errors.js";
import {
  ID_PATTERN,
  RequestValidationError,
  requestDocumentId,
  validateBody,
  validateDocumentId,
  validateFolderId,
  validateHash,
  validateRequiredHash,
  validateTitle,
  validateVersion,
} from "../http/validation.js";

const MAX_VIEW_ACTION_BYTES = 300_000;

function matchesIfNoneMatch(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  const header = value.trim();
  // The wildcard is special only as the complete field value.
  if (header === "*") return true;

  const tags: string[] = [];
  let start = 0;
  let inQuotes = false;
  // Opaque tags can contain commas, so split only outside the quoted value.
  for (let index = 0; index < header.length; index += 1) {
    if (header[index] === '"') inQuotes = !inQuotes;
    else if (header[index] === "," && !inQuotes) {
      tags.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (inQuotes) return false;
  tags.push(header.slice(start).trim());

  const entityTag = /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/u;
  if (tags.length === 0 || tags.some((tag) => !entityTag.test(tag))) return false;
  // If-None-Match uses weak comparison for GET and HEAD.
  return tags.some((tag) => tag.replace(/^W\//u, "") === etag);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new RequestValidationError(`${label} contains an unsupported field.`);
}

const SAFE_VIEW_KEY = /^(?!__proto__$|prototype$|constructor$)[A-Za-z0-9_.-]{1,80}$/;

function validateViewValue(value: unknown, depth = 0): VisualizationValue {
  if (depth > 6) throw new RequestValidationError("View values are nested too deeply.");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > 4_000) throw new RequestValidationError("A view value is too long.");
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 50) throw new RequestValidationError("View arrays may contain at most 50 items.");
    return value.map((item) => validateViewValue(item, depth + 1));
  }
  if (!isRecord(value)) throw new RequestValidationError("View values must be JSON scalars, arrays, or objects.");
  const entries = Object.entries(value);
  if (entries.length > 50 || entries.some(([key]) => !SAFE_VIEW_KEY.test(key))) throw new RequestValidationError("View objects may contain up to 50 simple fields.");
  const record: Record<string, VisualizationValue> = {};
  for (const [key, item] of entries) record[key] = validateViewValue(item, depth + 1);
  return record;
}

function validateViewRecord(value: unknown, label: string): Record<string, VisualizationValue> {
  if (!isRecord(value)) throw new RequestValidationError(`${label} must be a JSON object.`);
  const entries = Object.entries(value);
  if (entries.length > 50 || entries.some(([key]) => !SAFE_VIEW_KEY.test(key))) throw new RequestValidationError(`${label} may contain up to 50 simple fields.`);
  const record: Record<string, VisualizationValue> = {};
  for (const [key, item] of entries) record[key] = validateViewValue(item, 1);
  return record;
}

function validateVisualizationAction(value: unknown): VisualizationAction {
  if (!isRecord(value) || typeof value.type !== "string") throw new RequestValidationError("A visualization action type is required.");
  const action = value;
  switch (action.type) {
    case "note.create":
      assertOnlyKeys(action, ["type", "actionId", "title", "body", "frontmatter", "folderId"], "Create action");
      if (typeof action.actionId !== "string" || !ID_PATTERN.test(action.actionId)) throw new RequestValidationError("actionId must be a UUID.");
      return {
        type: "note.create", actionId: action.actionId, title: validateTitle(action.title),
        ...(action.body === undefined ? {} : { body: validateBody(action.body) }),
        ...(action.frontmatter === undefined ? {} : { frontmatter: validateViewRecord(action.frontmatter, "Frontmatter") }),
        ...(Object.hasOwn(action, "folderId") ? { folderId: action.folderId === null ? null : validateFolderId(action.folderId) } : {}),
      };
    case "note.update":
      assertOnlyKeys(action, ["type", "id", "expectedVersion", "expectedHash", "title", "body", "frontmatterPatch", "folderId"], "Update action");
      if (action.title === undefined && action.body === undefined && action.frontmatterPatch === undefined && action.folderId === undefined) {
        throw new RequestValidationError("Provide a note field to update.");
      }
      return {
        type: "note.update", id: validateDocumentId(String(action.id)), expectedVersion: validateVersion(action.expectedVersion),
        expectedHash: validateRequiredHash(action.expectedHash),
        ...(action.title === undefined ? {} : { title: validateTitle(action.title) }),
        ...(action.body === undefined ? {} : { body: validateBody(action.body) }),
        ...(action.frontmatterPatch === undefined ? {} : { frontmatterPatch: validateViewRecord(action.frontmatterPatch, "Frontmatter patch") }),
        ...(Object.hasOwn(action, "folderId") ? { folderId: action.folderId === null ? null : validateFolderId(action.folderId) } : {}),
      };
    case "note.frontmatter.patch":
      assertOnlyKeys(action, ["type", "id", "expectedVersion", "expectedHash", "patch"], "Frontmatter patch action");
      return {
        type: "note.frontmatter.patch", id: validateDocumentId(String(action.id)),
        expectedVersion: validateVersion(action.expectedVersion), expectedHash: validateRequiredHash(action.expectedHash),
        patch: validateViewRecord(action.patch, "Frontmatter patch"),
      };
    case "note.trash":
      assertOnlyKeys(action, ["type", "id", "expectedVersion", "expectedHash"], "Trash action");
      return {
        type: "note.trash", id: validateDocumentId(String(action.id)),
        expectedVersion: validateVersion(action.expectedVersion), expectedHash: validateRequiredHash(action.expectedHash),
      };
    case "trash.restore":
      assertOnlyKeys(action, ["type", "id", "expectedVersion", "folderId"], "Restore action");
      return {
        type: "trash.restore", id: validateDocumentId(String(action.id)), expectedVersion: validateVersion(action.expectedVersion),
        ...(Object.hasOwn(action, "folderId") ? { folderId: action.folderId === null ? null : validateFolderId(action.folderId) } : {}),
      };
    default:
      throw new RequestValidationError("This visualization action is not supported.");
  }
}

export function registerVisualizationRoutes(app: Express, database: KnowledgeDatabase): void {
  app.post("/api/views/query", (request, response) => {
    const serialized = JSON.stringify(request.body?.query);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > 16_000) {
      throw new RequestValidationError("query must be a JSON object smaller than 16 KB.");
    }
    const query = validateVisualizationQuery(request.body.query);
    response.json(queryVisualizationNotes(
      database.db,
      query,
      query.includeTrash ? listTrashedDocuments(database, MAX_VIEW_TRASH_CANDIDATES, MAX_VIEW_TRASH_BYTES) : [],
      (id) => readCurrentDocument(database, id),
    ));
  });

  app.get("/api/views/assets/:id", async (request, response) => {
    const id = requestDocumentId(request);
    const expectedHash = validateHash(request.query.v);
    if (!expectedHash) throw new RequestValidationError("A note content hash is required for view assets.");
    const current = readCurrentDocument(database, id);
    if (!current) throw new MissingDocumentError();
    const currentHash = current.contentHash || createHash("sha256").update(current.body, "utf8").digest("hex");
    if (expectedHash !== currentHash) throw new VersionConflictError(current.version, currentHash);

    const allowedQueryKeys = ["v", "asset", "field"];
    const hasAsset = typeof request.query.asset === "string";
    const hasField = typeof request.query.field === "string";
    if (Object.keys(request.query).some((key) => !allowedQueryKeys.includes(key)) || hasAsset === hasField) {
      throw new RequestValidationError("A view asset must name one referenced local image or supported frontmatter image field.");
    }

    let image: ReturnType<typeof validateLocalImage>;
    if (hasAsset) {
      const assetPath = request.query.asset as string;
      if (!database.vault || !current.filePath) {
        sendError(response, 404, "not_found", "The note does not reference this local image.");
        return;
      }
      const resolvedAssetPath = resolveReferencedLocalImagePath(
        current.body,
        current.filePath,
        assetPath,
        (relativePath, resolveUniqueBasename) => database.vault!.resolveAssetPath(relativePath, resolveUniqueBasename),
      );
      if (!resolvedAssetPath) {
        sendError(response, 404, "not_found", "The referenced local image is missing or ambiguous.");
        return;
      }
      const bytes = database.vault.readAsset(resolvedAssetPath, MAX_VISUALIZATION_IMAGE_BYTES);
      image = validateLocalImage(bytes, assetPath);
    } else {
      const field = request.query.field as string;
      const parsed = parseFrontmatter(current.body);
      const supportedFields = extractFrontmatterImageFields(parsed.values, current.filePath);
      if (!supportedFields.includes(field)) {
        sendError(response, 404, "not_found", "The note does not reference an approved image field.");
        return;
      }
      const source = resolveFrontmatterImageSource(
        parsed.values[field],
        current.filePath,
        (relativePath, resolveUniqueBasename) => database.vault?.resolveAssetPath(relativePath, resolveUniqueBasename),
      );
      if (!source) {
        sendError(response, 404, "not_found", "The referenced image is missing or unsupported.");
        return;
      }
      if (source.type === "remote") {
        image = await fetchRemoteVisualizationImage(source.url);
      } else {
        if (!database.vault) {
          sendError(response, 404, "not_found", "The referenced local image is unavailable.");
          return;
        }
        const bytes = database.vault.readAsset(source.path, MAX_VISUALIZATION_IMAGE_BYTES);
        image = validateLocalImage(bytes, source.path);
      }
    }

    const imageHash = createHash("sha256").update(image.bytes).digest("hex");
    const etag = `"${imageHash}"`;
    response.setHeader("Cache-Control", "private, max-age=300");
    response.setHeader("ETag", etag);
    response.setHeader("Content-Type", image.contentType);
    response.setHeader("Content-Length", image.bytes.byteLength);
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (matchesIfNoneMatch(request.get("if-none-match"), etag)) {
      response.status(304).end();
      return;
    }
    response.status(200).end(image.bytes);
  });

  app.post("/api/views/actions", (request, response) => {
    const serialized = JSON.stringify(request.body);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_VIEW_ACTION_BYTES) {
      throw new RequestValidationError("Visualization actions must be smaller than 300 KB.");
    }
    const action = validateVisualizationAction(request.body);
    if (action.type === "note.create") {
      let frontmatter: string;
      try { frontmatter = action.frontmatter ? serializeFrontmatter(action.frontmatter) : ""; }
      catch (error) { throw new RequestValidationError(error instanceof Error ? error.message : "Frontmatter is not supported."); }
      const body = frontmatter ? `---\n${frontmatter}\n---\n${action.body ?? ""}` : action.body ?? "";
      const existing = readCurrentDocument(database, action.actionId);
      if (existing) {
        if (existing.title !== action.title || existing.body !== body || existing.folderId !== (action.folderId ?? null)) {
          throw new VersionConflictError(existing.version, existing.contentHash);
        }
        response.json({ note: { id: existing.id, title: existing.title, version: existing.version, path: existing.filePath ?? "" } });
        return;
      }
      const created = createDocument(database, action.title, body, action.folderId ?? null, action.actionId);
      response.status(201).json({ note: { id: created.id, title: created.title, version: created.version, path: created.filePath ?? "" } });
      return;
    }
    if (action.type === "trash.restore") {
      const restored = restoreTrashedDocument(database, action.id, action.expectedVersion);
      response.json({ note: { id: restored.id, title: restored.title, version: restored.version, path: restored.filePath ?? "" } });
      return;
    }

    const current = readCurrentDocument(database, action.id);
    if (!current) throw new MissingDocumentError();
    const currentHash = current.contentHash || createHash("sha256").update(current.body, "utf8").digest("hex");
    if (current.version !== action.expectedVersion || currentHash !== action.expectedHash) {
      throw new VersionConflictError(current.version, currentHash);
    }
    if (action.type === "note.trash") {
      const note = trashDocument(database, action.id, action.expectedVersion, action.expectedHash);
      response.json({ trashed: { id: note.id, title: note.title, version: note.version, trashedAt: note.trashedAt } });
      return;
    }
    let body = current.body;
    if (action.type === "note.update" && action.body !== undefined) body = action.body;
    if (action.type === "note.frontmatter.patch") {
      try { body = patchFrontmatter(body, action.patch); }
      catch (error) { throw new RequestValidationError(error instanceof Error ? error.message : "Frontmatter could not be patched safely."); }
    } else if (action.type === "note.update" && action.frontmatterPatch) {
      try { body = patchFrontmatter(body, action.frontmatterPatch); }
      catch (error) { throw new RequestValidationError(error instanceof Error ? error.message : "Frontmatter could not be patched safely."); }
    }
    const title = action.type === "note.update" ? action.title ?? current.title : current.title;
    const folderId = action.type === "note.update" ? action.folderId : undefined;
    const updated = updateDocument(database, current.id, current.version, title, body, folderId, currentHash);
    response.json({ note: { id: updated.id, title: updated.title, version: updated.version, path: updated.filePath ?? "" } });
  });
}
