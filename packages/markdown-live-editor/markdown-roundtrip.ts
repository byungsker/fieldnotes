import {
  normalizeMarkdownLineEndings,
  stripNormalizedTerminalNewlines,
} from "./markdown-line-endings.ts";

export interface MarkdownSerializationApi {
  parse: (markdown: string) => unknown;
  serialize: (document: unknown) => string;
}

function isAtxHeading(line: string): boolean {
  return /^#{1,6}(?:[ \t]+.*|[ \t]*)$/.test(line);
}

function protectedMarkdownLines(lines: string[]): boolean[] {
  const protectedLines = lines.map(() => false);
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let htmlComment = false;
  let htmlTag: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fence) {
      protectedLines[index] = true;
      const closePattern = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`);
      if (closePattern.test(line)) fence = null;
      continue;
    }

    const fenceStart = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceStart) {
      protectedLines[index] = true;
      fence = { marker: fenceStart[0] as "`" | "~", length: fenceStart.length };
      continue;
    }

    if (htmlComment) {
      protectedLines[index] = true;
      if (line.includes("-->")) htmlComment = false;
      continue;
    }

    if (htmlTag) {
      protectedLines[index] = true;
      if (line.trim() === "" || new RegExp(`</${htmlTag}\\s*>`, "i").test(line)) htmlTag = null;
      continue;
    }

    if (/^ {0,3}<!--/.test(line) && !line.includes("-->")) {
      protectedLines[index] = true;
      htmlComment = true;
      continue;
    }

    const tag = /^ {0,3}<([A-Za-z][\w:-]*)\b/.exec(line)?.[1]?.toLowerCase();
    if (tag) {
      protectedLines[index] = true;
      const voidTag = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
      const closesOnLine = new RegExp(`</${tag}\\s*>`, "i").test(line);
      if (!voidTag.has(tag) && !closesOnLine && !/\/\s*>$/.test(line)) htmlTag = tag;
    }
  }

  return protectedLines;
}

function isPlainBlockBoundaryLine(line: string, isProtected: boolean): boolean {
  if (!line.trim() || isProtected) return false;
  if (/^[ \t]/.test(line)) return false;
  if (/^(?:>|[*+-]\s+|\d{1,9}[.)]\s+)/.test(line)) return false;
  if (/^(?:```|~~~|<)/.test(line)) return false;
  if (/(?: {2,}$|\\$)/.test(line)) return false;
  if (/^(?:[-*_][ \t]*){3,}$/.test(line)) return false;
  return true;
}

/** Normalize only blank-line counts directly between standalone ATX headings and plain blocks. */
function normalizeAtxHeadingBlockSpacing(markdown: string): string {
  const lines = markdown.split("\n");
  const protectedLines = protectedMarkdownLines(lines);
  const separators: Array<{ start: number; end: number }> = [];

  for (let start = 0; start < lines.length;) {
    if (!(lines[start] ?? "").trim()) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < lines.length && !(lines[end] ?? "").trim()) end += 1;
    if (end >= lines.length) break;

    const left = lines[start] ?? "";
    const right = lines[end] ?? "";
    const boundaryIsSafe = isPlainBlockBoundaryLine(left, protectedLines[start] ?? false)
      && isPlainBlockBoundaryLine(right, protectedLines[end] ?? false);
    if (boundaryIsSafe && (isAtxHeading(left) || isAtxHeading(right))) {
      separators.push({ start, end });
    }
    start = end;
  }

  for (const { start, end } of separators.reverse()) {
    const emptyLineCount = end - start - 1;
    if (emptyLineCount !== 1) lines.splice(start + 1, emptyLineCount, "");
  }
  return lines.join("\n");
}

/**
 * Check that Markdown serialization preserves source text and parsed structure.
 * The serializer may change the count of consecutive line breaks (for example,
 * between a standalone heading and a plain block), but other source changes
 * require source mode.
 */
export function hasContentPreservingMarkdownRoundTrip(
  markdownApi: MarkdownSerializationApi,
  markdown: string,
  retainTerminalNewlines = false,
): boolean {
  if (markdown === "") return true;

  try {
    const normalizedInput = normalizeMarkdownLineEndings(markdown);
    const normalizedOutput = normalizeMarkdownLineEndings(markdownApi.serialize(markdownApi.parse(markdown)));
    if (normalizedInput === null || normalizedOutput === null) return false;

    const comparisonInput = retainTerminalNewlines
      ? stripNormalizedTerminalNewlines(normalizedInput)
      : normalizedInput;
    const comparisonOutput = retainTerminalNewlines
      ? stripNormalizedTerminalNewlines(normalizedOutput)
      : normalizedOutput;
    if (comparisonInput === comparisonOutput) return true;

    if (normalizeAtxHeadingBlockSpacing(comparisonInput)
      !== normalizeAtxHeadingBlockSpacing(comparisonOutput)) return false;

    return JSON.stringify(markdownApi.parse(comparisonInput))
      === JSON.stringify(markdownApi.parse(comparisonOutput));
  } catch {
    return false;
  }
}
