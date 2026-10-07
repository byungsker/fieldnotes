export interface MarkdownParts {
  /** The original, byte-for-byte frontmatter prefix, including its final line ending. */
  frontmatter: string;
  body: string;
}

function getLine(source: string, start: number): { value: string; next: number } {
  const newline = source.indexOf("\n", start);
  const end = newline === -1 ? source.length : newline;
  const rawLine = source.slice(start, end);
  return {
    value: rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine,
    next: newline === -1 ? source.length : newline + 1,
  };
}

/**
 * Split only a closed YAML frontmatter block at the very beginning of a note.
 * Delimiter spelling, spacing, line endings, BOM, and all content are retained.
 */
export function splitLeadingFrontmatter(source: string): MarkdownParts {
  const bomLength = source.startsWith("\uFEFF") ? 1 : 0;
  const first = getLine(source, bomLength);
  if (first.value !== "---" || first.next === source.length) {
    return { frontmatter: "", body: source };
  }

  let cursor = first.next;
  while (cursor < source.length) {
    const line = getLine(source, cursor);
    if (line.value === "---") {
      return {
        frontmatter: source.slice(0, line.next),
        body: source.slice(line.next),
      };
    }
    if (line.next === cursor || line.next === source.length) break;
    cursor = line.next;
  }

  return { frontmatter: "", body: source };
}

export interface ParsedWikiLink {
  raw: string;
  target: string;
  fragment: string | null;
  alias: string | null;
}

/** Parse the supported target, fragment, and alias forms; retain the raw token. */
export function parseWikiLinkSyntax(raw: string): ParsedWikiLink | null {
  const match = /^\[\[([^\]|#\r\n]+)(?:#([^\]|\r\n]+))?(?:\|([^\]\r\n]+))?\]\]$/.exec(raw);
  if (!match) return null;
  const target = (match[1] ?? "").trim();
  if (!target) return null;
  return {
    raw,
    target,
    fragment: match[2]?.trim() || null,
    alias: match[3]?.trim() || null,
  };
}

/** Return a normalized URL only for links with an explicit safe web scheme. */
export function safeHttpUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Allow safe web images and same-origin relative asset paths, never data/script URLs. */
export function safeImageSource(rawSource: string): string | null {
  const source = rawSource.trim();
  const webUrl = safeHttpUrl(source);
  if (webUrl) return webUrl;
  const dataUrl = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(source);
  if (source.length <= 20_000 && dataUrl) {
    const encoded = dataUrl[1] ?? "";
    const unpadded = encoded.replace(/=+$/, "");
    const hasPadding = encoded.length !== unpadded.length;
    if (unpadded.length % 4 !== 1 && (!hasPadding || encoded.length % 4 === 0)) return source;
  }
  if (source.startsWith("/") && !source.startsWith("//") && !source.includes("\\")) {
    return source;
  }
  return null;
}

export function isStandaloneWebUrl(line: string): boolean {
  return safeHttpUrl(line) !== null && !/\s/.test(line.trim());
}
