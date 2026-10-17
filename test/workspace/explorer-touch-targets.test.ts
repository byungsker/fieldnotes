import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const stylesheet = readFileSync(path.resolve(import.meta.dirname, "../../src/app/styles.css"), "utf8");

test("touch-primary explorer devices keep row actions visible with 44px targets", () => {
  const touchRuleMatch = stylesheet.match(/@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*?)\n\}/);
  assert.ok(touchRuleMatch, "touch-primary media query exists");
  const touchRule = touchRuleMatch[1];

  assert.match(touchRule, /\.explorer-file-row \{ min-height: var\(--ds-control-touch\); \}/);
  assert.match(touchRule, /\.explorer-file-actions \{ pointer-events: auto; opacity: 1; transform: none; \}/);
  assert.match(touchRule, /\.explorer-file-actions button \{ width: var\(--ds-control-touch\); height: var\(--ds-control-touch\); \}/);
  assert.match(stylesheet, /\.left-rail\.mobile-navigation-drawer \.explorer-file-actions button \{ width: var\(--ds-control-touch\); height: var\(--ds-control-touch\); opacity: 1; \}/);
  assert.doesNotMatch(stylesheet, /@media \(any-hover: none\)/);
});
