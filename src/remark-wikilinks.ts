import type { Root } from "mdast";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MarkdownNode[];
};

const WIKILINK_PATTERN = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;

function makeText(value: string): MarkdownNode {
  return { type: "text", value };
}

function parseText(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(WIKILINK_PATTERN)) {
    const index = match.index ?? 0;
    const target = (match[1] ?? "").trim();
    const label = (match[2] ?? target).trim();
    if (index > lastIndex) nodes.push(makeText(value.slice(lastIndex, index)));
    if (target) {
      nodes.push({
        type: "link",
        url: `kb:${encodeURIComponent(target.toLocaleLowerCase())}`,
        title: null,
        children: [makeText(label)],
      });
    } else {
      nodes.push(makeText(match[0]));
    }
    lastIndex = index + match[0].length;
  }
  if (lastIndex < value.length) nodes.push(makeText(value.slice(lastIndex)));
  return nodes.length ? nodes : [makeText(value)];
}

function transform(parent: MarkdownNode): void {
  if (!parent.children) return;
  const children: MarkdownNode[] = [];
  for (const child of parent.children) {
    if (child.type === "text" && typeof child.value === "string") {
      children.push(...parseText(child.value));
    } else {
      transform(child);
      children.push(child);
    }
  }
  parent.children = children;
}

export function remarkWikiLinks() {
  return (tree: Root) => transform(tree as unknown as MarkdownNode);
}
