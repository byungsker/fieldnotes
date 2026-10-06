import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const stylesheet = readFileSync(path.join(root, "src/styles.css"), "utf8");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const mobileStart = stylesheet.lastIndexOf("@media (max-width: 820px)");
assert.ok(mobileStart >= 0, "mobile breakpoint exists");
const mobileStyles = stylesheet.slice(mobileStart, stylesheet.indexOf("@media (max-width: 380px)", mobileStart));
const narrowStyles = stylesheet.slice(stylesheet.indexOf("@media (max-width: 380px)", mobileStart));

function mobileRule(selector: string): string {
  const start = mobileStyles.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} has a mobile rule`);
  const end = mobileStyles.indexOf("}", start);
  assert.ok(end > start, `${selector} mobile rule is closed`);
  return mobileStyles.slice(start, end + 1);
}

test("mobile note titles, excerpts, and dates use a readable, distinct scale", () => {
  assert.match(mobileRule(".document-row-title"), /font-size: 18px/);
  assert.match(mobileRule(".document-row-title"), /font-weight: 700/);
  assert.match(mobileRule(".document-row-title"), /line-height: 1\.35/);
  assert.match(mobileRule(".document-row-title"), /-webkit-line-clamp: 2/);

  assert.match(mobileRule(".document-excerpt"), /font-size: 16px/);
  assert.match(mobileRule(".document-excerpt"), /line-height: 1\.55/);
  assert.match(mobileRule(".document-excerpt"), /#4c5a50/);

  assert.match(mobileRule(".document-row time"), /font-size: 14px/);
  assert.match(mobileRule(".document-row time"), /font-weight: 600/);
  assert.match(mobileRule(".document-row time"), /#56635a/);
  assert.match(mobileRule('html[data-theme="dark"] .document-row time'), /#a7b2a9/);
  assert.doesNotMatch(narrowStyles, /\.document-row-title\s*\{/);
});

test("UI and Markdown font stacks provide an explicit Korean system fallback", () => {
  assert.match(stylesheet, /font-family: "Avenir Next", "Apple SD Gothic Neo", -apple-system/);
  assert.match(stylesheet, /--serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Apple SD Gothic Neo"/);
});

test("mobile zoom remains available for accessibility", () => {
  const viewport = html.match(/<meta\s+name="viewport"[^>]*>/i)?.[0] ?? "";
  assert.match(viewport, /width=device-width/);
  assert.doesNotMatch(viewport, /maximum-scale\s*=\s*1|user-scalable\s*=\s*no/i);
  assert.doesNotMatch(stylesheet, /touch-action\s*:\s*none/i);
});
