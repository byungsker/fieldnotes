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

export function excerptFromMarkdown(markdown: string, maxLength = 150): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, "$2$1")
    .replace(/[#>*_`~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > maxLength ? `${plain.slice(0, maxLength - 1).trimEnd()}…` : plain;
}
