import path from "node:path";
import type { Express } from "express";
import { getDocument, listDocuments, MissingDocumentError, type KnowledgeDatabase } from "../storage/database.js";
import { MAX_VAULT_ASSET_BYTES } from "../storage/vault.js";
import { extractLocalImageReferenceTargets } from "../visualization/assets.js";
import { sendError } from "../http/errors.js";
import { RequestValidationError, validateDocumentId } from "../http/validation.js";

const MAX_PREVIEW_BABY_DOCUMENTS = 100;
const MAX_PREVIEW_BABY_CHARACTERS = 10_000_000;
const MAX_BABY_PREVIEW_IMAGE_BYTES = MAX_VAULT_ASSET_BYTES;
const BABY_PREVIEW_IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

function normalizedBabyPreviewAssetPath(value: string, markdownPath: string): string | undefined {
  const target = value.split("|", 1)[0]?.split("#", 1)[0]?.split("?", 1)[0]?.trim() ?? "";
  if (!target || target.length > 500 || target.includes("\\") || target.includes("\u0000")
    || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) return undefined;
  const rooted = target.startsWith("/");
  const pathValue = rooted ? target.slice(1) : target;
  const rawSegments = pathValue.split("/");
  if (rawSegments.some((segment) => !segment || segment === ".fieldnotes" || segment.startsWith(".fieldnotes-tmp-")
    || (rooted && (segment === "." || segment === "..")))) return undefined;
  const normalized = rooted
    ? path.posix.normalize(pathValue)
    : path.posix.normalize(path.posix.join(path.posix.dirname(markdownPath), pathValue));
  const segments = normalized.split("/");
  if (!normalized || normalized === "." || normalized.startsWith("../")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".fieldnotes" || segment.startsWith(".fieldnotes-tmp-"))
    || !BABY_PREVIEW_IMAGE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) return undefined;
  return normalized;
}

function staticBabyImageReference(body: string, source: string): boolean {
  for (const match of body.matchAll(/getAbstractFileByPath\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\)/gu)) {
    const value = match[2]?.replace(/\\(["'\\])/gu, "$1").replace(/\\n/gu, "\n");
    if (value === source || value === `/${source}`) return true;
  }
  return false;
}

function previewImageContentType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(bytes.toString("ascii", 8, 12))) return "image/avif";
  return undefined;
}
export function registerPreviewRoutes(app: Express, database: KnowledgeDatabase): void {
  app.get("/api/preview/babies", (_request, response) => {
    if (!database.vault) {
      response.json({ documents: [] });
      return;
    }
    const summaries = listDocuments(database.db)
      .filter((document) => document.filePath?.startsWith("babies/"))
      .slice(0, MAX_PREVIEW_BABY_DOCUMENTS);
    const documents = summaries
      .map((summary) => getDocument(database.db, summary.id))
      .filter((document) => document !== undefined);
    const totalCharacters = documents.reduce((total, document) => total + document.body.length, 0);
    if (totalCharacters > MAX_PREVIEW_BABY_CHARACTERS) {
      sendError(response, 413, "preview_too_large", "Baby note preview exceeds the local display limit.");
      return;
    }
    response.json({ documents });
  });

  app.get("/api/preview/babies/asset", (request, response) => {
    if (Object.keys(request.query).some((key) => !["documentId", "source"].includes(key))) {
      throw new RequestValidationError("Baby preview images accept only a note id and local image reference.");
    }
    if (typeof request.query.documentId !== "string" || typeof request.query.source !== "string") {
      throw new RequestValidationError("A note id and local image reference are required.");
    }
    const documentId = validateDocumentId(request.query.documentId);
    const current = getDocument(database.db, documentId);
    if (!current) throw new MissingDocumentError();
    if (!database.vault || !current.filePath?.startsWith("babies/")) {
      sendError(response, 404, "not_found", "Baby preview images are available only from local baby notes.");
      return;
    }

    const source = request.query.source.trim();
    const sourceTarget = source.split("|", 1)[0]?.split("#", 1)[0]?.split("?", 1)[0]?.trim() ?? "";
    const relativePath = normalizedBabyPreviewAssetPath(source, current.filePath);
    const rootPath = normalizedBabyPreviewAssetPath(source.startsWith("/") ? source : `/${source}`, current.filePath);
    if (!relativePath && !rootPath) {
      sendError(response, 404, "not_found", "The local image reference is invalid.");
      return;
    }
    const explicitTargets = extractLocalImageReferenceTargets(current.body, current.filePath, BABY_PREVIEW_IMAGE_EXTENSIONS);
    const explicitlyLinked = explicitTargets.includes(sourceTarget);
    const rootRelativeSyntax = sourceTarget.startsWith("/")
      || (sourceTarget.includes("/") && !sourceTarget.startsWith("./") && !sourceTarget.startsWith("../"));
    const resolveUniqueBasename = !sourceTarget.includes("/");
    let assetPath: string | undefined;
    if (explicitlyLinked && rootRelativeSyntax && rootPath) {
      assetPath = database.vault.resolveAssetPath(rootPath, false);
    }
    if (!assetPath && explicitlyLinked && relativePath) {
      assetPath = database.vault.resolveAssetPath(relativePath, resolveUniqueBasename);
    }
    if (!assetPath && staticBabyImageReference(current.body, source) && rootPath) {
      assetPath = database.vault.resolveAssetPath(rootPath, resolveUniqueBasename);
    }
    if (!assetPath) {
      sendError(response, 404, "not_found", "The referenced local image is missing or ambiguous.");
      return;
    }

    const bytes = database.vault.readAsset(assetPath, MAX_BABY_PREVIEW_IMAGE_BYTES);
    const contentType = previewImageContentType(bytes);
    if (!contentType) {
      sendError(response, 415, "unsupported_image", "Only verified local raster images can be shown in the baby preview.");
      return;
    }
    response
      .status(200)
      .set("Content-Type", contentType)
      .set("Content-Disposition", "inline")
      .set("Cache-Control", "private, max-age=120")
      .set("X-Content-Type-Options", "nosniff")
      .set("Content-Length", String(bytes.byteLength))
      .end(bytes);
  });
}
