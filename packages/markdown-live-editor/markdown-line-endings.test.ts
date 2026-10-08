import assert from "node:assert/strict";
import test from "node:test";
import {
  detectMarkdownLineEndingStyle,
  normalizeMarkdownLineEndings,
  restoreMarkdownLineEndings,
  splitTerminalNewlineSuffix,
  stripNormalizedTerminalNewlines,
} from "./markdown-line-endings.ts";

test("uniform CRLF is compared as Markdown and restored after serialization", () => {
  const source = "# Heading\r\n\r\nBody\r\n";
  assert.equal(detectMarkdownLineEndingStyle(source), "crlf");
  assert.equal(normalizeMarkdownLineEndings(source), "# Heading\n\nBody\n");
  assert.equal(restoreMarkdownLineEndings("# Heading\n\nEdited body\n", "crlf"), "# Heading\r\n\r\nEdited body\r\n");
});

test("mixed and bare-CR line endings are not directly normalizable for rich parsing", () => {
  for (const source of ["one\r\ntwo\n", "one\rtwo"]) {
    assert.equal(detectMarkdownLineEndingStyle(source), null);
    assert.equal(normalizeMarkdownLineEndings(source), null);
  }
});

test("uniform LF remains unchanged", () => {
  const source = "# Heading\n\nBody\n";
  assert.equal(detectMarkdownLineEndingStyle(source), "lf");
  assert.equal(normalizeMarkdownLineEndings(source), source);
  assert.equal(restoreMarkdownLineEndings(source, "lf"), source);
});

test("terminal newlines can be preserved as an exact suffix around rich content", () => {
  const parts = splitTerminalNewlineSuffix("# Heading\r\n\r\nBody\r\n\r\n");
  assert.deepEqual(parts, { content: "# Heading\r\n\r\nBody", suffix: "\r\n\r\n" });
  assert.equal(stripNormalizedTerminalNewlines("# Heading\n\nBody\n\n"), "# Heading\n\nBody");
});
