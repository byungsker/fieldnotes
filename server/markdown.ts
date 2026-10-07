import { markdownBodyForPreview } from "../shared/markdown-frontmatter.js";

const WIKILINK_PATTERN = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;

export function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function extractWikilinkTargets(markdown: string): string[] {
  const withoutFencedCode = markdown.replace(/(^|\n)(```|~~~)[\s\S]*?\n\2[^\n]*(?=\n|$)/g, "$1");
  const withoutInlineCode = withoutFencedCode.replace(/(`+)(.*?)\1/g, "");
  const targets = new Set<string>();
  for (const match of withoutInlineCode.matchAll(WIKILINK_PATTERN)) {
    const target = normalizeTitle(match[1] ?? "");
    if (target) targets.add(target);
  }
  return [...targets];
}

export function excerptFromMarkdown(markdown: string, maxLength = 150, query = ""): string {
  const plain = markdownBodyForPreview(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, "$2$1")
    .replace(/[#>*_`~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const needle = query.trim().toLocaleLowerCase();
  const matchIndex = needle ? plain.toLocaleLowerCase().indexOf(needle) : -1;
  if (matchIndex < 0) return plain.length > maxLength ? `${plain.slice(0, maxLength - 1).trimEnd()}…` : plain;

  const excerptLength = Math.max(maxLength, needle.length + 24);
  let start = Math.max(0, Math.min(matchIndex - Math.floor((excerptLength - needle.length) / 2), plain.length - excerptLength));
  const nextBoundary = start > 0 ? plain.indexOf(" ", start) : -1;
  if (nextBoundary > start && nextBoundary < matchIndex) start = nextBoundary + 1;
  let end = Math.min(plain.length, start + excerptLength);
  const previousBoundary = end < plain.length ? plain.lastIndexOf(" ", end) : -1;
  if (previousBoundary > matchIndex + needle.length) end = previousBoundary;
  const excerpt = `${start > 0 ? "…" : ""}${plain.slice(start, end).trim()}${end < plain.length ? "…" : ""}`;
  return excerpt;
}
