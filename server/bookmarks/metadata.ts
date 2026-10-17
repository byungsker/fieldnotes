import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import type { LookupAddress } from "node:dns";

export interface BookmarkMetadata {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
}

export class UnsafeBookmarkUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeBookmarkUrlError";
  }
}

export class BookmarkMetadataFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookmarkMetadataFetchError";
  }
}

const MAX_URL_LENGTH = 2_048;
const MAX_HTML_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 5_000;

function ipv4ToNumber(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  if (octets.some((part) => part < 0 || part > 255)) return null;
  return (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

function ipv4InCidr(address: string, network: string, prefix: number): boolean {
  const value = ipv4ToNumber(address);
  const base = ipv4ToNumber(network);
  if (value === null || base === null) return true;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv6ToBigInt(address: string): bigint | null {
  let normalized = address.toLowerCase().split("%", 1)[0];
  if (!normalized || normalized.includes(":::")) return null;
  const dottedStart = normalized.lastIndexOf(":");
  if (normalized.includes(".") && dottedStart >= 0) {
    const ipv4 = ipv4ToNumber(normalized.slice(dottedStart + 1));
    if (ipv4 === null) return null;
    normalized = `${normalized.slice(0, dottedStart)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...right];
  if (words.length !== 8) return null;
  return words.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
}

function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !blocked.some(([network, prefix]) => ipv4InCidr(address, network, prefix));
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  if ((value >> 32n) === 0xffffn) {
    const ipv4 = Number(value & 0xffffffffn);
    return isPublicIpv4(`${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`);
  }
  // Only globally routable unicast space is accepted. This excludes unspecified,
  // loopback, ULA, link-local, multicast, documentation, and transition ranges.
  const inGlobalUnicast = (value >> 125n) === 1n; // 2000::/3
  const inDocumentation = (value >> 96n) === 0x20010db8n; // 2001:db8::/32
  const inSpecial2001 = (value >> 105n) === 0x100080n; // 2001::/23 special-purpose space
  const in6to4 = (value >> 112n) === 0x2002n; // 2002::/16 embeds arbitrary IPv4
  return inGlobalUnicast && !inDocumentation && !inSpecial2001 && !in6to4;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function parseSafeHttpsUrl(input: string): URL {
  if (input.length > MAX_URL_LENGTH) throw new UnsafeBookmarkUrlError("Bookmark URL is too long.");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeBookmarkUrlError("Bookmark must be a valid HTTPS URL.");
  }
  const hostname = normalizeHostname(url.hostname);
  if (url.protocol !== "https:" || !hostname || url.username || url.password || (url.port && url.port !== "443")) {
    throw new UnsafeBookmarkUrlError("Only HTTPS bookmark URLs on the standard port are supported.");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new UnsafeBookmarkUrlError("Local and internal bookmark hosts are not allowed.");
  }
  url.hash = "";
  return url;
}

export interface PublicHttpsTarget {
  url: URL;
  hostname: string;
  address: LookupAddress;
}

export async function resolvePublicHttpsTarget(
  input: string,
  resolve: (hostname: string) => Promise<LookupAddress[]> = (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
): Promise<PublicHttpsTarget> {
  const url = parseSafeHttpsUrl(input);
  const hostname = normalizeHostname(url.hostname);
  const family = isIP(hostname);
  let addresses: LookupAddress[];
  try {
    addresses = family ? [{ address: hostname, family }] : await resolve(hostname);
  } catch {
    throw new BookmarkMetadataFetchError("Bookmark host could not be resolved.");
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new UnsafeBookmarkUrlError("Bookmark host resolves to a private or reserved IP address.");
  }
  return { url, hostname, address: addresses[0] };
}

interface HtmlResponse {
  status: number;
  location: string | undefined;
  contentType: string;
  body: string;
}

function requestHtml(target: PublicHttpsTarget): Promise<HtmlResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: target.address.address,
      port: 443,
      method: "GET",
      path: `${target.url.pathname}${target.url.search}`,
      servername: isIP(target.hostname) ? undefined : target.hostname,
      headers: {
        Host: target.url.host,
        Accept: "text/html,application/xhtml+xml;q=0.9",
        "Accept-Encoding": "identity",
        "User-Agent": "FieldnotesBookmarkPreview/1.0",
      },
      agent: false,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(target.hostname, certificate),
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      const contentType = response.headers["content-type"] ?? "";
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        resolve({ status, location, contentType, body: "" });
        return;
      }
      const contentLength = Number(response.headers["content-length"] ?? 0);
      if (contentLength > MAX_HTML_BYTES || !/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType)) {
        response.destroy(new Error("Expected a small HTML page."));
        reject(new BookmarkMetadataFetchError("Bookmark page is not a small HTML document."));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_HTML_BYTES) {
          response.destroy(new Error("Bookmark HTML exceeds the size limit."));
          reject(new BookmarkMetadataFetchError("Bookmark HTML exceeds the size limit."));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => resolve({ status, location, contentType, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", () => reject(new BookmarkMetadataFetchError("Could not read bookmark page.")));
    });
    request.on("timeout", () => request.destroy(new Error("Bookmark request timed out.")));
    request.on("error", () => reject(new BookmarkMetadataFetchError("Could not fetch bookmark metadata.")));
    request.end();
  });
}

function decodeHtml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const numeric = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 0x10ffff || (numeric >= 0xd800 && numeric <= 0xdfff)) return "�";
      return String.fromCodePoint(numeric);
    }
    return ({ amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: " " } as Record<string, string>)[code.toLowerCase()] ?? entity;
  });
}

function cleanMetadataText(value: string | undefined, maxLength = 400): string | null {
  const withoutControls = [...decodeHtml(value ?? "").replace(/<[^>]*>/g, " ")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("");
  const cleaned = withoutControls.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function tagAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(pattern)) {
    attributes[(match[1] ?? "").toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function extractHtmlMetadata(html: string, url: URL): BookmarkMetadata {
  const meta = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = tagAttributes(match[0]);
    const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
    const content = attributes.content;
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  let image: string | null = null;
  const imageValue = cleanMetadataText(meta.get("og:image"), MAX_URL_LENGTH);
  if (imageValue) {
    try {
      const parsed = new URL(imageValue, url);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) image = parsed.href.slice(0, MAX_URL_LENGTH);
    } catch {
      image = null;
    }
  }
  return {
    title: cleanMetadataText(meta.get("og:title")) ?? cleanMetadataText(titleMatch?.[1]),
    description: cleanMetadataText(meta.get("og:description") ?? meta.get("description")),
    image,
    siteName: cleanMetadataText(meta.get("og:site_name"), 160) ?? url.hostname,
    url: url.href,
  };
}

export async function fetchBookmarkMetadata(
  input: string,
  dependencies: {
    resolve?: (hostname: string) => Promise<LookupAddress[]>;
    request?: (target: PublicHttpsTarget) => Promise<HtmlResponse>;
  } = {},
): Promise<BookmarkMetadata> {
  let current = input;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const target = await resolvePublicHttpsTarget(current, dependencies.resolve);
    const response = await (dependencies.request ?? requestHtml)(target);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location || redirectCount === MAX_REDIRECTS) throw new BookmarkMetadataFetchError("Bookmark redirected too many times.");
      current = new URL(response.location, target.url).href;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new BookmarkMetadataFetchError(`Bookmark host returned HTTP ${response.status}.`);
    if (!/^text\/html\b|^application\/xhtml\+xml\b/i.test(response.contentType)) {
      throw new BookmarkMetadataFetchError("Bookmark page is not an HTML document.");
    }
    return extractHtmlMetadata(response.body, target.url);
  }
  throw new BookmarkMetadataFetchError("Bookmark redirected too many times.");
}
