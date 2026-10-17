import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { MarkdownBody } from "../../src/pages/workspace/ui/MarkdownBody";
import { markdownBodyForPreview } from "../../src/pages/workspace/lib/markdown-preview";

const render = (markdown: string) => renderToStaticMarkup(
  <MarkdownBody markdown={markdown} documents={[]} onOpenDocument={() => undefined} />,
);

test("preview hides only a complete document-start YAML frontmatter block", () => {
  const source = "---\ntitle: Private metadata\nlayout: note\n---\n\n# Readable body\n\n---\n\nA body separator stays.";
  const rendered = render(source);

  assert.doesNotMatch(rendered, /Private metadata|layout: note/);
  assert.match(rendered, /Readable body/);
  assert.match(rendered, /A body separator stays\./);
  assert.equal(markdownBodyForPreview(source), "\n# Readable body\n\n---\n\nA body separator stays.");
  assert.equal(source.startsWith("---\ntitle: Private metadata"), true);
});

test("frontmatter preview parsing accepts CRLF and a leading BOM", () => {
  assert.equal(markdownBodyForPreview("---\r\ntitle: Example\r\n---\r\nBody"), "Body");
  assert.equal(markdownBodyForPreview("\uFEFF---\ntitle: Example\n---\nBody"), "Body");
});

test("preview preserves Markdown without frontmatter, including rules and fenced separators", () => {
  const source = "A paragraph.\n\n---\n\n```yaml\n---\nmetadata: stays in code\n```";
  assert.equal(markdownBodyForPreview(source), source);
  assert.match(render(source), /metadata: stays in code/);
});

test("an unclosed or malformed frontmatter opener remains visible and unchanged", () => {
  const unclosed = "---\ntitle: Incomplete\n\nBody that must not disappear";
  const malformed = "--- not a delimiter\ntitle: Visible\n---\nBody";
  assert.equal(markdownBodyForPreview(unclosed), unclosed);
  assert.equal(markdownBodyForPreview(malformed), malformed);
  assert.match(render(unclosed), /Incomplete/);
  assert.match(render(unclosed), /Body that must not disappear/);
});

test("Markdown preview renders only bounded raster data images and skips unsafe HTML", () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownBody, {
      markdown: "![safe](data:image/webp;base64,QUJD)\n\n![unsafe](data:image/svg+xml;base64,PHN2Zz4=)\n\n<script>alert(1)</script>",
      documents: [],
      onOpenDocument: () => undefined,
    }),
  );
  assert.match(markup, /<img[^>]+src="data:image\/webp;base64,QUJD"/);
  assert.match(markup, /Image omitted: unsupported or unsafe source\./);
  assert.doesNotMatch(markup, /<script|alert\(1\)/);
});
