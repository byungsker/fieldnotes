export type MarkdownLineEndingStyle = "lf" | "crlf";

/** Detect the single line-ending style that can be retained after rich editing. */
export function detectMarkdownLineEndingStyle(source: string): MarkdownLineEndingStyle | null {
  const withoutCrlf = source.replace(/\r\n/g, "");
  if (withoutCrlf.includes("\r")) return null;
  const hasCrlf = source.includes("\r\n");
  const hasBareLf = withoutCrlf.includes("\n");
  if (hasCrlf && hasBareLf) return null;
  return hasCrlf ? "crlf" : "lf";
}

/** Normalize only uniform LF/CRLF input for loss-detection comparisons. */
export function normalizeMarkdownLineEndings(source: string): string | null {
  if (detectMarkdownLineEndingStyle(source) === null) return null;
  return source.replace(/\r\n/g, "\n");
}

/** Apply the document's original uniform newline style to Markdown serialization. */
export function restoreMarkdownLineEndings(source: string, style: MarkdownLineEndingStyle): string {
  return source.replace(/\r\n|\r|\n/g, style === "crlf" ? "\r\n" : "\n");
}

/** Separate terminal line breaks so the editor can preserve their exact count. */
export function splitTerminalNewlineSuffix(source: string): { content: string; suffix: string } {
  const match = /((?:\r\n|\n)+)$/.exec(source);
  return match
    ? { content: source.slice(0, match.index), suffix: match[1] ?? "" }
    : { content: source, suffix: "" };
}

export function stripNormalizedTerminalNewlines(source: string): string {
  return source.replace(/\n+$/, "");
}
