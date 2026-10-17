import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreservedMarkdownPreview } from "./PreservedMarkdownPreview.tsx";
import type { MarkdownLiveEditorAdapters } from "./types.ts";

void React;

function render(raw: string, documentPath = "reading/note.md", adapters: MarkdownLiveEditorAdapters = {
  resolveReferencedVaultAsset: (documentId, assetPath, hash) =>
    `/api/views/assets/${documentId}?asset=${encodeURIComponent(assetPath)}&v=${hash}`,
}) {
  return renderToStaticMarkup(React.createElement(PreservedMarkdownPreview, {
    raw,
    context: {
      documentId: "fake-document-id",
      documentPath,
      documentHash: "fake-content-hash",
      adapters,
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

const customImages: MarkdownLiveEditorAdapters = {
  resolveLocalImage: ({ source }) => `/local-preview?source=${encodeURIComponent(source)}`,
};

test("passes bare filenames unchanged to the host image resolver", () => {
  const html = render("![[Pasted image 2026-03-15.jpg|width=400]]\n\n![Moment](<another photo.jpg>)", "journal/records/2026-03-15.md", customImages);

  assert.match(html, /src="\/local-preview\?source=Pasted%20image%202026-03-15\.jpg"/u);
  assert.match(html, /src="\/local-preview\?source=another%20photo\.jpg"/u);
  assert.doesNotMatch(html, /\/api\/views\/assets/u);
});

test("passes explicit relative paths unchanged to the host image resolver", () => {
  const html = render("![[photos/day.jpg]]", "journal/records/2026-03-15.md", customImages);

  assert.match(html, /src="\/local-preview\?source=photos%2Fday\.jpg"/u);
  assert.doesNotMatch(html, /\/api\/views\/assets/u);
});

test("keeps a vault-root photo path for the default image resolver", () => {
  const html = render(
    "![[/assets/photos/2026-05-01/example.jpg]]",
    "journal/records/2026-05-01.md",
  );

  assert.match(html, /src="\/api\/views\/assets\/fake-document-id\?asset=assets%2Fphotos%2F2026-05-01%2Fexample\.jpg&amp;v=fake-content-hash"/u);
  assert.doesNotMatch(html, /journal%2Frecords%2Fassets/u);
});

test("omits remote images and reports that they were not loaded", () => {
  const html = render("![external](https://images.example.test/photo.jpg)");

  assert.match(html, /Image omitted: unsupported or unsafe source\./u);
  assert.doesNotMatch(html, /images\.example\.test|https:\/\//u);
  assert.doesNotMatch(html, /<img\b/u);
});

test("validates local sources before calling the host and stays inert without adapters", () => {
  let calls = 0;
  const html = render("![remote](https://images.example.test/photo.jpg)\n\n![[../../../outside.jpg]]\n\n![[.fieldnotes/hidden.jpg]]", "reading/note.md", {
    resolveLocalImage: () => { calls += 1; return "/should-not-load.jpg"; },
  });
  assert.equal(calls, 0);
  assert.doesNotMatch(html, /<img\b/u);
  const unavailable = render("![[photo.jpg]]", "reading/note.md", {});
  assert.match(unavailable, /Local image preview is unavailable/u);
  assert.doesNotMatch(unavailable, /<img\b|\/api\//u);
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
