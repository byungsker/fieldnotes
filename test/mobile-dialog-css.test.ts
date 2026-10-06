import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const stylesheet = readFileSync(path.resolve(import.meta.dirname, "../src/styles.css"), "utf8");

test("mobile dialog sheet overrides desktop sizing and retains 16px form controls", () => {
  const desktopRule = stylesheet.indexOf(".action-dialog { width: min(");
  const mobileBreakpoint = stylesheet.indexOf("@media (max-width: 820px)");
  const mobileRuleStart = stylesheet.indexOf(".action-dialog { box-sizing: border-box;", mobileBreakpoint);
  assert.ok(desktopRule >= 0 && mobileBreakpoint > desktopRule && mobileRuleStart > mobileBreakpoint);

  const mobileRuleEnd = stylesheet.indexOf("}", mobileRuleStart);
  const mobileRule = stylesheet.slice(mobileRuleStart, mobileRuleEnd + 1);
  assert.match(mobileRule, /position: fixed/);
  assert.match(mobileRule, /inset: auto 0 0/);
  assert.match(mobileRule, /width: 100%/);
  assert.match(mobileRule, /max-width: none/);
  assert.match(mobileRule, /border-radius: 20px 20px 0 0/);
  assert.match(mobileRule, /--fieldnotes-visual-height/);
  assert.match(stylesheet, /input:not\(\.title-input\), textarea, select \{ font-size: 16px !important; \}/);
  assert.equal(stylesheet.slice(mobileRuleEnd + 1).includes(".action-dialog { width: min("), false);
});
