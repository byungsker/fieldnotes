import assert from "node:assert/strict";
import test from "node:test";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { common, createLowlight } from "lowlight";
import type { JSONContent } from "@tiptap/core";
import { BookmarkCard } from "./BookmarkCardExtension.tsx";
import { WikiLink } from "./WikiLinkExtension.tsx";
import { hasContentPreservingMarkdownRoundTrip, type MarkdownSerializationApi } from "./markdown-roundtrip.ts";
import { splitLeadingFrontmatter } from "./markdown-safety.ts";

interface BlockDocument {
  content: Array<{ type: "heading" | "paragraph"; text: string }>;
}

const blockMarkdown: MarkdownSerializationApi = {
  parse(markdown) {
    const content = markdown.replace(/\r\n/g, "\n")
      .split(/\n{1,}/)
      .filter(Boolean)
      .map((line) => line.startsWith("## ")
        ? { type: "heading" as const, text: line.slice(3) }
        : { type: "paragraph" as const, text: line });
    return { content } satisfies BlockDocument;
  },
  serialize(document) {
    const { content } = document as BlockDocument;
    return content.map((block) => block.type === "heading" ? `## ${block.text}` : block.text).join("\n\n");
  },
};

function sourceApi(serialize: (markdown: string) => string): MarkdownSerializationApi {
  return {
    parse: (markdown) => ({ source: markdown }),
    serialize: (document) => serialize((document as { source: string }).source),
  };
}

function createTiptapMarkdownApi(): MarkdownSerializationApi {
  const lowlight = createLowlight(common);
  const manager = new MarkdownManager({
    extensions: [
      StarterKit.configure({ codeBlock: false, link: false }),
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: "plaintext" }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: false, protocols: ["http", "https"] }),
      Image.configure({ inline: false, allowBase64: false }),
      WikiLink,
      BookmarkCard,
      Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
    ],
    markedOptions: { gfm: true, breaks: false },
  });
  return {
    parse: (markdown) => manager.parse(markdown),
    serialize: (document) => manager.serialize(document as JSONContent),
  };
}

test("allows canonical block spacing when parsed content is unchanged", () => {
  assert.equal(hasContentPreservingMarkdownRoundTrip(blockMarkdown, "## 야 이게 뭐야\n장난하니"), true);
  assert.equal(hasContentPreservingMarkdownRoundTrip(blockMarkdown, "## heading\n\n\nparagraph"), true);
});

test("does not normalize paragraph spacing without a heading boundary", () => {
  const source = "first paragraph\n\n\nsecond paragraph";
  assert.equal(hasContentPreservingMarkdownRoundTrip(sourceApi((markdown) => markdown.replace(/\n{3}/, "\n\n")), source), false);
});

test("preserves hard-break spaces, including next to a heading", () => {
  const source = "## heading\nparagraph  \nbreak";
  const serializer = sourceApi((markdown) => markdown.replace("paragraph  ", "paragraph "));
  assert.equal(hasContentPreservingMarkdownRoundTrip(serializer, source), false);

  const canonicalSpacingAndLostBreak = sourceApi((markdown) => markdown
    .replace("## heading\n", "## heading\n\n")
    .replace("paragraph  \n", "paragraph \n"));
  assert.equal(hasContentPreservingMarkdownRoundTrip(canonicalSpacingAndLostBreak, source), false);
});

test("preserves fenced code whitespace and blank lines", () => {
  const source = "## heading\n\n```ts\nconst value  = 1;\n\nnext()\n```";
  const alteredCode = sourceApi((markdown) => markdown.replace("const value  = 1;\n\n", "const value = 1;\n"));
  assert.equal(hasContentPreservingMarkdownRoundTrip(alteredCode, source), false);

  const alteredFenceBoundary = sourceApi((markdown) => markdown.replace("## heading\n\n```ts", "## heading\n```ts"));
  assert.equal(hasContentPreservingMarkdownRoundTrip(alteredFenceBoundary, source), false);
});

test("preserves list markers and nested indentation", () => {
  const source = "- parent\n  - child\n    - nested";
  const alteredIndent = sourceApi((markdown) => markdown.replace("  - child", " - child"));
  const alteredMarker = sourceApi((markdown) => markdown.replace("- parent", "+ parent"));
  assert.equal(hasContentPreservingMarkdownRoundTrip(alteredIndent, source), false);
  assert.equal(hasContentPreservingMarkdownRoundTrip(alteredMarker, source), false);
});

test("preserves raw HTML and wikilink source", () => {
  const html = "<div>\n## heading\n\nbody\n</div>";
  const alteredHtml = sourceApi((markdown) => markdown.replace("<div>", "<section>"));
  assert.equal(hasContentPreservingMarkdownRoundTrip(alteredHtml, html), false);

  const wikilink = "[[Daily note#section|an alias]]";
  const alteredWikilink = sourceApi((markdown) => markdown.replace("an alias", "another alias"));
  assert.equal(hasContentPreservingMarkdownRoundTrip(alteredWikilink, wikilink), false);
});

test("keeps frontmatter byte-for-byte outside the rich-editor body", () => {
  const source = "---\r\ntitle:  A title\r\ntags:\r\n  - one\r\n---\r\n## heading\r\nparagraph";
  const parts = splitLeadingFrontmatter(source);
  assert.equal(parts.frontmatter, "---\r\ntitle:  A title\r\ntags:\r\n  - one\r\n---\r\n");
  assert.equal(parts.body, "## heading\r\nparagraph");
  assert.equal(parts.frontmatter + parts.body, source);
});

test("protects the frontmatter separator so the rich editor sees the first Markdown block", () => {
  const source = "---\ntitle: Fixture\n---\n\n## Heading\nParagraph";
  const parts = splitLeadingFrontmatter(source);
  assert.equal(parts.frontmatter, "---\ntitle: Fixture\n---\n\n");
  assert.equal(parts.body, "## Heading\nParagraph");
  assert.equal(parts.frontmatter + parts.body, source);
  assert.equal(hasContentPreservingMarkdownRoundTrip(blockMarkdown, parts.body), true);
  assert.equal(hasContentPreservingMarkdownRoundTrip(blockMarkdown, `\n${parts.body}`), false);
});

test("frontmatter plus its separator do not duplicate or change after actual TipTap serialization", () => {
  const source = "\uFEFF---\ntitle:  Fixture\n---\n\n  \n## Heading\n\n---\n\n## Next";
  const parts = splitLeadingFrontmatter(source);
  const markdownApi = createTiptapMarkdownApi();
  const serializedBody = markdownApi.serialize(markdownApi.parse(parts.body));
  assert.equal(parts.frontmatter, "\uFEFF---\ntitle:  Fixture\n---\n\n  \n");
  assert.equal(parts.body, "## Heading\n\n---\n\n## Next");
  assert.equal(hasContentPreservingMarkdownRoundTrip(markdownApi, parts.body), true);
  assert.equal(parts.frontmatter + serializedBody, source);
});

test("rejects serialization that drops parsed content", () => {
  const lossyMarkdown: MarkdownSerializationApi = {
    parse: (markdown) => ({ content: markdown.split(/\n+/).filter(Boolean) }),
    serialize: () => "kept paragraph",
  };

  assert.equal(hasContentPreservingMarkdownRoundTrip(lossyMarkdown, "## heading\nparagraph"), false);
});

test("rejects parsers that silently discard non-whitespace source", () => {
  const discardingMarkdown: MarkdownSerializationApi = {
    parse: () => ({ content: [] }),
    serialize: () => "",
  };

  assert.equal(hasContentPreservingMarkdownRoundTrip(discardingMarkdown, "%% unsupported content"), false);
});

test("preserves terminal newline handling and rejects mixed endings", () => {
  assert.equal(hasContentPreservingMarkdownRoundTrip(blockMarkdown, "## heading\r\nparagraph\r\n", true), true);
  assert.equal(hasContentPreservingMarkdownRoundTrip(blockMarkdown, "first\r\nsecond\nthird"), false);
});
