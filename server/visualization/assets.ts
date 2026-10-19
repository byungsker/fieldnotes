import path from "node:path";
import { LOCAL_RASTER_EXTENSIONS, MAX_VAULT_ASSET_BYTES } from "../storage/vault/constants.js";

export const MAX_VISUALIZATION_IMAGE_BYTES = MAX_VAULT_ASSET_BYTES;
const LOCAL_IMAGE_EXTENSIONS = LOCAL_RASTER_EXTENSIONS;
const VIEW_IMAGE_FRONTMATTER_FIELDS = ["cover", "image", "photo", "poster", "thumbnail"] as const;
const TRUSTED_REMOTE_IMAGE_HOSTS = new Set([
  "contents.kyobobook.co.kr",
  "image.aladin.co.kr",
  "image.tmdb.org",
]);

export class VisualizationAssetError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "VisualizationAssetError";
  }
}

export type VisualizationImage = { bytes: Buffer; contentType: string };
export type FrontmatterImageSource = { type: "local"; path: string } | { type: "remote"; url: string };

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function hasAvifFileTypeBrand(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp") return false;

  const size32 = bytes.readUInt32BE(0);
  let brandsOffset = 8;
  let boxEnd = size32 === 0 ? bytes.length : size32;
  if (size32 === 1) {
    if (bytes.length < 24) return false;
    const largeSize = bytes.readBigUInt64BE(8);
    if (largeSize < 24n || largeSize > BigInt(bytes.length)) return false;
    brandsOffset = 16;
    boxEnd = Number(largeSize);
  } else if (size32 !== 0 && (size32 < 16 || size32 > bytes.length)) {
    return false;
  }
  if (boxEnd < brandsOffset + 8) return false;

  const isAvifBrand = (offset: number) => ["avif", "avis"].includes(bytes.toString("ascii", offset, offset + 4));
  if (isAvifBrand(brandsOffset)) return true;
  for (let offset = brandsOffset + 8; offset + 4 <= boxEnd; offset += 4) {
    if (isAvifBrand(offset)) return true;
  }
  return false;
}

function localImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 6 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (hasAvifFileTypeBrand(bytes)) return "image/avif";
  return undefined;
}

export function validateLocalImage(bytes: Buffer, relativePath: string): VisualizationImage {
  if (bytes.byteLength > MAX_VISUALIZATION_IMAGE_BYTES) {
    throw new VisualizationAssetError(413, "visualization_asset_too_large", "Image exceeds the 25 MB view asset limit.");
  }
  const extension = path.posix.extname(relativePath).toLowerCase();
  const contentType = localImageMime(bytes);
  if (!LOCAL_IMAGE_EXTENSIONS.has(extension) || !contentType) {
    throw new VisualizationAssetError(415, "visualization_asset_type", "Only verified JPEG, PNG, WebP, GIF, and AVIF images are available to views.");
  }
  return { bytes, contentType };
}

function normalizedRemoteImageUrl(value: string): string | undefined {
  if (value.length > 2_048 || value.trim() !== value || hasControlCharacters(value)) return undefined;
  let url: URL;
  try { url = new URL(value); }
  catch { return undefined; }
  if (url.protocol !== "https:" || !TRUSTED_REMOTE_IMAGE_HOSTS.has(url.hostname.toLowerCase())
    || url.username || url.password || url.port || url.hash
    || !LOCAL_IMAGE_EXTENSIONS.has(path.posix.extname(url.pathname).toLowerCase())) return undefined;
  return url.href;
}

/** frontmatter 이미지가 지원되는 로컬 경로 또는 원격 호스트로 확인된 필드만 반환한다. */
export function extractFrontmatterImageFields(
  values: Record<string, unknown>,
  markdownPath?: string,
): string[] {
  return VIEW_IMAGE_FRONTMATTER_FIELDS.filter((field) => {
    const value = values[field];
    if (typeof value !== "string" || !value) return false;
    if (normalizedRemoteImageUrl(value)) return true;
    return Boolean(markdownPath && normalizeLocalReference(value, markdownPath));
  });
}

/** 임의의 로컬 경로나 원격 호스트를 허용하지 않고 frontmatter 이미지 필드를 해석한다. */
export function resolveFrontmatterImageSource(
  value: unknown,
  markdownPath: string | undefined,
  resolveAssetPath: (relativePath: string, resolveUniqueBasename?: boolean) => string | undefined,
): FrontmatterImageSource | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const remoteUrl = normalizedRemoteImageUrl(value);
  if (remoteUrl) return { type: "remote", url: remoteUrl };
  if (!markdownPath) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(value); }
  catch { return undefined; }
  const assetPath = normalizeLocalReference(decoded, markdownPath);
  if (!assetPath) return undefined;
  const exactPath = resolveAssetPath(assetPath, false);
  if (exactPath) return { type: "local", path: exactPath };
  if (!decoded.includes("/") && !decoded.startsWith("/")) {
    const uniquePath = resolveAssetPath(assetPath, true);
    if (uniquePath) return { type: "local", path: uniquePath };
  }
  return undefined;
}

/** 승인된 공개 이미지 origin에서만 이미지를 가져오고 바이트 형식을 확인한다. */
export async function fetchRemoteVisualizationImage(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<VisualizationImage> {
  const normalizedUrl = normalizedRemoteImageUrl(url);
  if (!normalizedUrl) throw new VisualizationAssetError(404, "visualization_asset_missing", "The note does not reference an approved remote image.");
  let response: Response;
  try {
    response = await fetcher(normalizedUrl, {
      redirect: "error",
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new VisualizationAssetError(502, "visualization_remote_image_unavailable", "The referenced image provider is unavailable.");
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new VisualizationAssetError(502, "visualization_remote_image_unavailable", "The referenced image provider is unavailable.");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_VISUALIZATION_IMAGE_BYTES) {
    void response.body.cancel().catch(() => undefined);
    throw new VisualizationAssetError(413, "visualization_asset_too_large", "Image exceeds the 25 MB view asset limit.");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      byteLength += chunk.byteLength;
      if (byteLength > MAX_VISUALIZATION_IMAGE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new VisualizationAssetError(413, "visualization_asset_too_large", "Image exceeds the 25 MB view asset limit.");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof VisualizationAssetError) throw error;
    throw new VisualizationAssetError(502, "visualization_remote_image_unavailable", "The referenced image provider is unavailable.");
  }
  return validateLocalImage(Buffer.concat(chunks, byteLength), new URL(normalizedUrl).pathname);
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
    let decodedTarget: string;
    try { decodedTarget = decodeURIComponent(target); }
    catch { continue; }
    const normalized = normalizeLocalReference(decodedTarget, markdownPath);
    if (normalized) paths.add(normalized);
  }
  return [...paths].slice(0, 20);
}

/** Resolve a referenced asset while retaining the older vault-root and unique-basename link behavior. */
export function resolveReferencedLocalImagePath(
  markdown: string,
  markdownPath: string,
  assetPath: string,
  resolveAssetPath: (relativePath: string, resolveUniqueBasename?: boolean) => string | undefined,
): string | undefined {
  if (!extractLocalImageReferences(markdown, markdownPath).includes(assetPath)) return undefined;

  const exactPath = resolveAssetPath(assetPath, false);
  if (exactPath) return exactPath;

  for (const rawTarget of extractLocalImageReferenceTargets(markdown, markdownPath)) {
    const target = rawTarget.split("|", 1)[0]?.split("#", 1)[0]?.split("?", 1)[0]?.trim() ?? "";
    let decodedTarget: string;
    try { decodedTarget = decodeURIComponent(target); }
    catch { continue; }
    if (normalizeLocalReference(decodedTarget, markdownPath) !== assetPath) continue;

    if (!decodedTarget.includes("/") && !decodedTarget.startsWith("/")) {
      const uniqueMatch = resolveAssetPath(assetPath, true);
      if (uniqueMatch) return uniqueMatch;
      continue;
    }

    if (!decodedTarget.startsWith("./") && !decodedTarget.startsWith("../")) {
      const rootTarget = decodedTarget.startsWith("/") ? decodedTarget : `/${decodedTarget}`;
      const rootPath = normalizeLocalReference(rootTarget, "");
      if (rootPath) {
        const rootMatch = resolveAssetPath(rootPath, false);
        if (rootMatch) return rootMatch;
      }
    }
  }

  return undefined;
}
