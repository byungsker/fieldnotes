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
  const match = /(\n[^\S\n]*(?:\n[^\S\n]*)+)$/u.exec(source);
  if (!match) return { content: source, suffix: "" };
  return { content: source.slice(0, match.index), suffix: match[1] || "" };
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

      if (suffix) content.push({ type: "preservedWhitespace", attrs: { raw: suffix } });
    }

    const document: JSONContent = { type: "doc", content };
    if (manager.serialize(document) === normalized) return document;
  } catch {
    // Prefer an explicit full-source block over a lossy or partial parse.
  }

  return preservedSourceDocument(normalized);
}
