import { mergeAttributes, nodeInputRule, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { parseWikiLinkSyntax } from "./markdown-safety.ts";

interface WikiLinkAttributes {
  raw: string;
  target: string;
  fragment: string | null;
  alias: string | null;
}

function labelFor(attributes: Partial<WikiLinkAttributes>): string {
  return attributes.alias?.trim() || attributes.target?.trim() || "Wiki link";
}

function WikiLinkView({ node }: NodeViewProps) {
  const attributes = node.attrs as WikiLinkAttributes;
  return (
    <NodeViewWrapper
      as="span"
      className="mle-wikilink-token"
      title={attributes.fragment ? `${attributes.target} · ${attributes.fragment}` : attributes.target}
      aria-label={`Wikilink: ${labelFor(attributes)}`}
      contentEditable={false}
    >
      {labelFor(attributes)}
    </NodeViewWrapper>
  );
}

export const WikiLink = Node.create({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      raw: { default: "" },
      target: { default: "" },
      fragment: { default: null },
      alias: { default: null },
    };
  },

  parseHTML() {
    return [{
      tag: "span[data-mle-wikilink]",
      getAttrs: (element) => {
        const parsed = parseWikiLinkSyntax(element.getAttribute("data-mle-wikilink") || "");
        return parsed || false;
      },
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attributes = node.attrs as WikiLinkAttributes;
    return ["span", mergeAttributes(HTMLAttributes, {
      class: "mle-wikilink-token",
      "data-mle-wikilink": attributes.raw,
      title: attributes.fragment ? `${attributes.target} · ${attributes.fragment}` : attributes.target,
    }), labelFor(attributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WikiLinkView);
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: /\[\[([^\]|#\r\n]+)(?:#([^\]|\r\n]+))?(?:\|([^\]\r\n]+))?\]\]$/,
        type: this.type,
        getAttributes: (match) => parseWikiLinkSyntax(match[0]) || {},
      }),
    ];
  },

  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start: (source) => source.indexOf("[["),
    tokenize: (source) => {
      const match = /^\[\[([^\]|#\r\n]+)(?:#([^\]|\r\n]+))?(?:\|([^\]\r\n]+))?\]\]/.exec(source);
      if (!match) return undefined;
      const parsed = parseWikiLinkSyntax(match[0]);
      return parsed ? { type: "wikiLink", ...parsed } : undefined;
    },
  },

  parseMarkdown: (token) => {
    const raw = typeof token.raw === "string" ? token.raw : "";
    const parsed = parseWikiLinkSyntax(raw);
    return parsed ? { type: "wikiLink", attrs: parsed } : { type: "text", text: raw };
  },

  renderMarkdown: (node) => {
    const raw = typeof node.attrs?.raw === "string" ? node.attrs.raw : "";
    return parseWikiLinkSyntax(raw) ? raw : "";
  },
});
