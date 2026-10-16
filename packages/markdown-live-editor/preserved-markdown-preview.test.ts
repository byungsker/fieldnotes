import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreservedMarkdownPreview } from "./PreservedMarkdownPreview.tsx";

void React;

function render(raw: string) {
  return renderToStaticMarkup(React.createElement(PreservedMarkdownPreview, {
    raw,
    context: {
      documentId: "fake-document-id",
      documentPath: "reading/note.md",
      documentHash: "fake-content-hash",
      adapters: {
        resolveReferencedVaultAsset: (documentId, assetPath, hash) =>
          `/api/views/assets/${documentId}?asset=${encodeURIComponent(assetPath)}&v=${hash}`,
      },
    },
  }));
}

test("renders ordinary Markdown and vault-local attachments without source controls", () => {
  const html = render("# Reading note\n\nA preserved paragraph.\n\n![[../assets/cover.png|width=400]]\n\n![Moment](<photos/day with spaces.webp>)");

  assert.match(html, /<h1>Reading note<\/h1>/u);
  assert.match(html, /A preserved paragraph\./u);
  assert.match(html, /<img src="\/api\/views\/assets\/fake-document-id\?asset=assets%2Fcover\.png&amp;v=fake-content-hash"/u);
  assert.match(html, /asset=reading%2Fphotos%2Fday%20with%20spaces\.webp/u);
  assert.doesNotMatch(html, /Markdown source kept as-is|View preserved source|>Remove<|\.\.\/assets\/cover\.png/u);
});

test("renders Obsidian image embeds with encoded paths and preserves Markdown angle destinations", () => {
  const html = render("![[Pasted image 20240101.png]]\n\n![Moment](<photos/day with spaces.webp>)");

  assert.match(html, /asset=reading%2FPasted%20image%2020240101\.png&amp;v=fake-content-hash/u);
  assert.match(html, /asset=reading%2Fphotos%2Fday%20with%20spaces\.webp&amp;v=fake-content-hash/u);
  assert.doesNotMatch(html, /Embedded HTML is preserved but not rendered/u);
  assert.doesNotMatch(html, /!\[\[|<photos\/day with spaces\.webp/u);
});

test("omits remote images and reports that they were not loaded", () => {
  const html = render("![external](https://images.example.test/photo.jpg)");

  assert.match(html, /Image omitted: unsupported or unsafe source\./u);
  assert.doesNotMatch(html, /images\.example\.test|https:\/\//u);
  assert.doesNotMatch(html, /<img\b/u);
});

test("does not display or run DataviewJS source and keeps a clear security warning", () => {
  const html = render("Before.\n\n```dataviewjs\nthrow new Error('private source');\n```\n\nAfter.");

  assert.match(html, /Before\./u);
  assert.match(html, /After\./u);
  assert.match(html, /DataviewJS is preserved and was not run\./u);
  assert.doesNotMatch(html, /private source|throw new Error/u);
});

test("does not render preserved raw HTML and warns that embedded HTML is hidden", () => {
  const html = render("<div><script>privateSource()</script></div>");

  assert.match(html, /Embedded HTML is preserved but not rendered in this preview\./u);
  assert.doesNotMatch(html, /<script|privateSource\(\)/u);
});
