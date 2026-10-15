import type { JSONContent } from "@tiptap/core";
import type { MarkdownManager } from "@tiptap/markdown";
import { detectMarkdownLineEndingStyle, normalizeMarkdownLineEndings } from "./markdown-line-endings.ts";

function preservedSourceDocument(source: string): JSONContent {
  return {
    type: "doc",
    content: [{ type: "preservedMarkdown", attrs: { raw: source } }],
  };
}

function splitTrailingBlankLines(source: string): { content: string; suffix: string } {
  const match = /(\n[^\S\n]*(?:\n[^\S\n]*)*)$/u.exec(source);
  if (!match) return { content: source, suffix: "" };
  return { content: source.slice(0, match.index), suffix: match[1] || "" };
}

function isSafeLocalRasterReference(raw: string): boolean {
  const target = raw.split("|", 1)[0]?.split("#", 1)[0]?.split("?", 1)[0]?.trim() ?? "";
  const pathValue = target.startsWith("/") ? target.slice(1) : target;
  const segments = pathValue.split("/");
  return Boolean(target && target.length <= 500 && !target.includes("\\") && !target.startsWith("//")
    && !/^[a-z][a-z0-9+.-]*:/iu.test(target)
    && ![...target].some((character) => (character.codePointAt(0) ?? 0) < 32 || (character.codePointAt(0) ?? 0) === 127)
    && segments.every((segment) => segment && segment !== "." && segment !== ".." && segment !== ".fieldnotes" && !segment.startsWith(".fieldnotes-tmp-"))
    && /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(target));
}

function isLocalMediaEmbedParagraph(token: { type: string; raw?: string }): boolean {
  if (token.type !== "paragraph" || !token.raw) return false;
  const text = token.raw.replace(/`+[^`\n]*`+/gu, "");
  for (const match of text.matchAll(/!\[\[([^\]\r\n]+)\]\]/gu)) {
    if (isSafeLocalRasterReference(match[1] ?? "")) return true;
  }
  for (const match of text.matchAll(/!\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+[^)]*)?\)/gu)) {
    if (isSafeLocalRasterReference(match[1] ?? match[2] ?? "")) return true;
  }
  return false;
}

/**
 * Parse Markdown blocks into editable rich nodes and retain blocks that change
 * under parse/serialize as explicit read-only source nodes. Exact whitespace
 * separators are stored as their own invisible nodes, avoiding normalization
 * around unsupported blocks.
 */
export function parseMarkdownWithPreservedBlocks(manager: MarkdownManager, source: string): JSONContent {
  if (!source) return { type: "doc", content: [{ type: "paragraph" }] };

  const lineEndingStyle = detectMarkdownLineEndingStyle(source);
  if (lineEndingStyle === null) return preservedSourceDocument(source);

  const normalized = normalizeMarkdownLineEndings(source);
  if (normalized === null) return preservedSourceDocument(source);

  try {
    const lexer = new manager.instance.Lexer(manager.instance.defaults);
    const tokens = lexer.lex(normalized);
    if (tokens.map((token) => token.raw || "").join("") !== normalized) {
      return preservedSourceDocument(normalized);
    }

    const content: JSONContent[] = [];
    for (const token of tokens) {
      const raw = token.raw || "";
      if (!raw) continue;

      if (token.type === "space") {
        content.push({ type: "preservedWhitespace", attrs: { raw } });
        continue;
      }

      const { content: blockSource, suffix } = splitTrailingBlankLines(raw);
      if (blockSource) {
        const language = token.type === "code" && typeof token.lang === "string"
          ? token.lang.trim().split(/[ \t]+/u)[0]?.toLowerCase()
          : undefined;
        if (language === "dataviewjs" || isLocalMediaEmbedParagraph(token)) {
          content.push({ type: "preservedMarkdown", attrs: { raw: blockSource } });
        } else {
          try {
            const parsed = manager.parse(blockSource);
            if (manager.serialize(parsed) === blockSource) {
              content.push(...(parsed.content || []));
            } else {
              content.push({ type: "preservedMarkdown", attrs: { raw: blockSource } });
            }
          } catch {
            content.push({ type: "preservedMarkdown", attrs: { raw: blockSource } });
          }
        }
      }

      if (suffix) content.push({ type: "preservedWhitespace", attrs: { raw: suffix } });
    }

    const document: JSONContent = { type: "doc", content };
    if (manager.serialize(document) === normalized) return document;
  } catch {
    // Prefer an explicit full-source block over a lossy or partial parse.
  }

  return preservedSourceDocument(normalized);
}
