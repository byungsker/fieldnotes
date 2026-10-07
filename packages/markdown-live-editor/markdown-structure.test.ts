import assert from "node:assert/strict";
import test from "node:test";
import { extractHeadings } from "./markdown-structure.ts";

test("table of contents extracts ATX headings and skips fenced code", () => {
  const headings = extractHeadings("# First\n\n```md\n## not a heading\n```\n\n  ### Third ###\n###### Last\n");
  assert.deepEqual(headings, [
    { index: 0, level: 1, text: "First" },
    { index: 1, level: 3, text: "Third" },
    { index: 2, level: 6, text: "Last" },
  ]);
});
