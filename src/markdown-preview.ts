export function markdownBodyForPreview(markdown: string): string {
  const start = markdown.startsWith("\uFEFF") ? 1 : 0;
  const openingEnd = markdown.indexOf("\n", start);
  if (openingEnd < 0 || markdown.slice(start, openingEnd).replace(/\r$/, "") !== "---") return markdown;

  let lineStart = openingEnd + 1;
  while (lineStart <= markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? markdown.length : newline;
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (line === "---" || line === "...") return markdown.slice(newline < 0 ? lineEnd : newline + 1);
    if (newline < 0) break;
    lineStart = newline + 1;
  }

  return markdown;
}
