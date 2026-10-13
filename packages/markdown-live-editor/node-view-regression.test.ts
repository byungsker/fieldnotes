import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const customNodeViewFiles = [
  "./BookmarkCardExtension.tsx",
  "./PreservedMarkdownExtension.tsx",
  "./WikiLinkExtension.tsx",
];

test("custom Markdown node views do not enter Tiptap ReactRenderer flushSync", () => {
  for (const relativePath of customNodeViewFiles) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /ReactNodeViewRenderer|ReactMarkViewRenderer|from ["']@tiptap\/react["']/u, relativePath);
    assert.match(source, /addNodeView\(\)/u, relativePath);
  }
});
