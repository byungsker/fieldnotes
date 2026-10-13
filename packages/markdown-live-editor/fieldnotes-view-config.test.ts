import assert from "node:assert/strict";
import test from "node:test";
import { parseFieldnotesViewConfig } from "./fieldnotes-view-config.ts";

test("parses versioned table, calendar, and custom visualization blocks", () => {
  const table = parseFieldnotesViewConfig('```fieldnotes-view\n{"version":1,"view":"table","columns":["title","frontmatter.status"]}\n```');
  const calendar = parseFieldnotesViewConfig('~~~fieldnotes-view\n{"version":1,"view":"calendar","dateField":"frontmatter.due"}\n~~~');
  const customJson = JSON.stringify({ version: 1, view: "custom", js: 'return { html: "<p>fixture</p>" };' });
  const custom = parseFieldnotesViewConfig(["```fieldnotes-view", customJson, "```"].join("\n"));
  assert.equal(table.view, "table");
  assert.equal(calendar.dateField, "frontmatter.due");
  assert.equal(custom.view, "custom");
});

test("rejects malformed or unbounded visualization source", () => {
  assert.throws(() => parseFieldnotesViewConfig("not a fence"), /fenced `fieldnotes-view`/);
  assert.throws(() => parseFieldnotesViewConfig('```fieldnotes-view\n{"version":2,"view":"table"}\n```'), /version 1/);
  assert.throws(() => parseFieldnotesViewConfig('```fieldnotes-view\n{"version":1,"view":"custom"}\n```'), /JavaScript/);
  assert.throws(() => parseFieldnotesViewConfig(["```fieldnotes-view", "x".repeat(24_001), "```"].join("\n")), /larger than 24 KB/);
});
