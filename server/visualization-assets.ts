import path from "node:path";

export const MAX_VISUALIZATION_IMAGE_BYTES = 1_000_000;
const TMDB_IMAGE_ORIGIN = "https://image.tmdb.org";
const TMDB_IMAGE_PATH = /^\/t\/p\/(?:w\d{1,4}|original)\/[A-Za-z0-9._/-]{1,1200}$/u;
const LOCAL_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export class VisualizationAssetError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "VisualizationAssetError";
  }
}

export type VisualizationImage = { bytes: Buffer; contentType: string };
export type PosterImageFetcher = (input: URL, init: RequestInit) => Promise<Response>;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

/** Public TMDb poster references are the only remote image source accepted by views. */
export function isAllowedTmdbPosterUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048 || hasControlCharacters(value) || [...value].some((character) => character.codePointAt(0) === 32)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== TMDB_IMAGE_ORIGIN || url.username || url.password || url.port || url.search || url.hash) return false;
  if (!TMDB_IMAGE_PATH.test(url.pathname)) return false;
  if (url.pathname.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return url.href === value;
}

function localImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export function validateLocalImage(bytes: Buffer, relativePath: string): VisualizationImage {
  if (bytes.byteLength > MAX_VISUALIZATION_IMAGE_BYTES) {
    throw new VisualizationAssetError(413, "visualization_asset_too_large", "Image exceeds the 1 MB view asset limit.");
  }
  const extension = path.posix.extname(relativePath).toLowerCase();
  const contentType = localImageMime(bytes);
  if (!LOCAL_IMAGE_EXTENSIONS.has(extension) || !contentType || MIME_BY_EXTENSION[extension] !== contentType) {
    throw new VisualizationAssetError(415, "visualization_asset_type", "Only verified JPEG, PNG, and WebP images are available to views.");
  }
  return { bytes, contentType };
}

function normalizeLocalReference(target: string, markdownPath: string, allowedExtensions = LOCAL_IMAGE_EXTENSIONS): string | undefined {
  if (!target || target.length > 1_024 || target.includes("\\") || hasControlCharacters(target)
    || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) return undefined;
  const sourceDirectory = path.posix.dirname(markdownPath);
  const normalized = path.posix.normalize(path.posix.isAbsolute(target)
    ? target.slice(1)
    : path.posix.join(sourceDirectory === "." ? "" : sourceDirectory, target));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".fieldnotes" || segment.startsWith(".fieldnotes-tmp-"))) return undefined;
  if (!allowedExtensions.has(path.posix.extname(normalized).toLowerCase())) return undefined;
  return normalized;
}

function stripFencedCode(markdown: string): string {
  const lines = markdown.split(/\r\n?|\n/u);
  let fenceCharacter: "`" | "~" | undefined;
  let fenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!fenceCharacter) {
      const opening = line.match(/^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)$/u);
      if (!opening) continue;
      const delimiter = opening[1] ?? "";
      const info = opening[2] ?? "";
      if (delimiter[0] === "`" && info.includes("`")) continue;
      fenceCharacter = delimiter[0] as "`" | "~";
      fenceLength = delimiter.length;
      lines[index] = "";
      continue;
    }

    const closing = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/u);
    lines[index] = "";
    const delimiter = closing?.[1];
    if (delimiter && delimiter[0] === fenceCharacter && delimiter.length >= fenceLength) {
      fenceCharacter = undefined;
      fenceLength = 0;
    }
  }

  return lines.join("\n");
}

/** Extract explicit raster-image targets outside fenced code, retaining their written path syntax. */
export function extractLocalImageReferenceTargets(
  markdown: string,
  markdownPath: string,
  allowedExtensions = LOCAL_IMAGE_EXTENSIONS,
): string[] {
  const withoutFencedCode = stripFencedCode(markdown);
  const targets = new Set<string>();
  const add = (rawTarget: string) => {
    const target = rawTarget.split("|", 1)[0]?.split("#", 1)[0]?.trim() ?? "";
    if (normalizeLocalReference(target, markdownPath, allowedExtensions)) targets.add(target);
  };
  for (const match of withoutFencedCode.matchAll(/!\[\[([^\]\r\n]+)\]\]/gu)) add(match[1] ?? "");
  for (const match of withoutFencedCode.matchAll(/!\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+[^)]*)?\)/gu)) {
    add(match[1] ?? match[2] ?? "");
  }
  return [...targets].slice(0, 20);
}

/** Extract only explicit, relative raster-image references from a note body. */
export function extractLocalImageReferences(markdown: string, markdownPath: string): string[] {
  const paths = new Set<string>();
  for (const target of extractLocalImageReferenceTargets(markdown, markdownPath)) {
    const normalized = normalizeLocalReference(target, markdownPath);
    if (normalized) paths.add(normalized);
  }
  return [...paths].slice(0, 20);
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VISUALIZATION_IMAGE_BYTES) {
    throw new VisualizationAssetError(413, "visualization_asset_too_large", "Image exceeds the 1 MB view asset limit.");
  }
  if (!response.body) throw new VisualizationAssetError(502, "visualization_asset_unavailable", "The public image is unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VISUALIZATION_IMAGE_BYTES) {
        await reader.cancel();
        throw new VisualizationAssetError(413, "visualization_asset_too_large", "Image exceeds the 1 MB view asset limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function validateRemoteImage(bytes: Buffer, contentType: string): VisualizationImage {
  const declaredType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  const actualType = localImageMime(bytes);
  if (!actualType || actualType !== declaredType) {
    throw new VisualizationAssetError(415, "visualization_asset_type", "The public image did not return a verified raster image.");
  }
  return { bytes, contentType: actualType };
}

export async function fetchPublicTmdbPoster(
  value: string,
  fetcher: PosterImageFetcher = fetch,
): Promise<VisualizationImage> {
  if (!isAllowedTmdbPosterUrl(value)) {
    throw new VisualizationAssetError(404, "visualization_asset_not_found", "The referenced poster is not an approved public image.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetcher(new URL(value), {
      method: "GET",
      headers: { Accept: "image/jpeg, image/png, image/webp" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new VisualizationAssetError(502, "visualization_asset_unavailable", "The public image is unavailable.");
    }
    const contentType = response.headers.get("content-type") ?? "";
    const bytes = await readBoundedResponse(response);
    return validateRemoteImage(bytes, contentType);
  } catch (error) {
    if (error instanceof VisualizationAssetError) throw error;
    throw new VisualizationAssetError(502, "visualization_asset_unavailable", "The public image is unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}
