import assert from "node:assert/strict";
import test from "node:test";
import {
  safeHttpUrl,
  safeImageSource,
  parseWikiLinkSyntax,
  splitLeadingFrontmatter,
} from "./markdown-safety.ts";
import { extractHeadings } from "./markdown-structure.ts";

test("frontmatter is split without changing delimiters, BOM, or CRLF bytes", () => {
  const source = "\uFEFF---\r\ntitle: Notes\r\n---\r\n# Body\r\n";
  const parts = splitLeadingFrontmatter(source);
  assert.equal(parts.frontmatter, "\uFEFF---\r\ntitle: Notes\r\n---\r\n");
  assert.equal(parts.body, "# Body\r\n");
  assert.equal(parts.frontmatter + parts.body, source);
});

test("frontmatter keeps following blank separator lines byte-for-byte in its protected prefix", () => {
  const source = "\uFEFF---\r\ntitle: Notes\r\n---\r\n\r\n  \r\n# Body\r\n";
  const parts = splitLeadingFrontmatter(source);
  assert.equal(parts.frontmatter, "\uFEFF---\r\ntitle: Notes\r\n---\r\n\r\n  \r\n");
  assert.equal(parts.body, "# Body\r\n");
  assert.equal(parts.frontmatter + parts.body, source);
});

test("frontmatter separation stops before leading whitespace on the first body line", () => {
  const source = "---\ntitle: Fixture\n---\n\n  indented body\n";
  const parts = splitLeadingFrontmatter(source);
  assert.equal(parts.frontmatter, "---\ntitle: Fixture\n---\n\n");
  assert.equal(parts.body, "  indented body\n");
  assert.equal(parts.frontmatter + parts.body, source);
});

test("unclosed or non-leading frontmatter remains ordinary Markdown", () => {
  for (const source of ["---\ntitle: Notes\n", "# Heading\n---\ntitle: Notes\n---\n"]) {
    assert.deepEqual(splitLeadingFrontmatter(source), { frontmatter: "", body: source });
  }
});

test("supported wikilinks retain exact target, fragment, alias, and source spelling", () => {
  assert.deepEqual(parseWikiLinkSyntax("[[Project Atlas#milestones|Quarterly plan]]"), {
    raw: "[[Project Atlas#milestones|Quarterly plan]]",
    target: "Project Atlas",
    fragment: "milestones",
    alias: "Quarterly plan",
  });
  assert.deepEqual(parseWikiLinkSyntax("[[ Notes ]]"), {
    raw: "[[ Notes ]]",
    target: "Notes",
    fragment: null,
    alias: null,
  });
  assert.equal(parseWikiLinkSyntax("[[Notes#]]"), null);
  assert.equal(parseWikiLinkSyntax("[[Notes|]]"), null);
});

test("frontmatter and fenced Markdown are kept as an exact source prefix/body", () => {
  const fenced = "---\ntitle: Draft\n---\n```md\n# literal heading\n[[literal link]]\n```\n# Real heading\n";
  const parts = splitLeadingFrontmatter(fenced);
  assert.equal(parts.frontmatter + parts.body, fenced);
  assert.equal(parts.frontmatter, "---\ntitle: Draft\n---\n");
  assert.deepEqual(extractHeadings(parts.body), [{ index: 0, level: 1, text: "Real heading" }]);
});

test("the editor table of contents ignores headings inside fenced code", () => {
  assert.deepEqual(extractHeadings("# One\n~~~md\n## Code example\n~~~\n### Two ###\n"), [
    { index: 0, level: 1, text: "One" },
    { index: 1, level: 3, text: "Two" },
  ]);
});

test("link and image URL helpers reject script, data, and credential URLs", () => {
  assert.equal(safeHttpUrl(" javascript:alert(1) "), null);
  assert.equal(safeHttpUrl("data:text/html,hello"), null);
  assert.equal(safeHttpUrl("https://user:pass@example.test/"), null);
  assert.equal(safeHttpUrl("example.test"), null);
  assert.equal(safeHttpUrl("https://example.test/a"), "https://example.test/a");
  assert.equal(safeImageSource("/assets/photo.png"), "/assets/photo.png");
  assert.equal(safeImageSource("//example.test/photo.png"), null);
  assert.equal(safeImageSource("data:image/svg+xml,<svg/>"), null);
  assert.equal(safeImageSource("data:image/webp;base64,QUJD"), "data:image/webp;base64,QUJD");
  assert.equal(safeImageSource("data:image/png;base64,not base64"), null);
  const maxImageDataUrl = "data:image/png;base64," + "A".repeat(20_000 - "data:image/png;base64,".length);
  assert.equal(maxImageDataUrl.length, 20_000);
  assert.equal(safeImageSource(maxImageDataUrl), maxImageDataUrl);
  assert.equal(safeImageSource(maxImageDataUrl + "A"), null);
  assert.equal(safeImageSource("data:image/png;base64," + "A".repeat(20_000)), null);
});
