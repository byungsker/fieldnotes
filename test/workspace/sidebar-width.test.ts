import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampDesktopSidebarWidth,
  DESKTOP_SIDEBAR_MAX_WIDTH,
  DESKTOP_SIDEBAR_MIN_WIDTH,
  normalizeDesktopSidebarWidth,
} from "../../src/pages/workspace/model/sidebar-width.js";

test("desktop sidebar width is constrained to the supported range", () => {
  assert.equal(clampDesktopSidebarWidth(DESKTOP_SIDEBAR_MIN_WIDTH - 20), DESKTOP_SIDEBAR_MIN_WIDTH);
  assert.equal(clampDesktopSidebarWidth(DESKTOP_SIDEBAR_MAX_WIDTH + 20), DESKTOP_SIDEBAR_MAX_WIDTH);
  assert.equal(clampDesktopSidebarWidth(319.7), 320);
  assert.equal(clampDesktopSidebarWidth(Number.NaN), DESKTOP_SIDEBAR_MIN_WIDTH);
});

test("stored desktop sidebar widths are parsed and normalized safely", () => {
  assert.equal(normalizeDesktopSidebarWidth(null), null);
  assert.equal(normalizeDesktopSidebarWidth(""), null);
  assert.equal(normalizeDesktopSidebarWidth("auto"), null);
  assert.equal(normalizeDesktopSidebarWidth("1e3"), null);
  assert.equal(normalizeDesktopSidebarWidth("NaN"), null);
  assert.equal(normalizeDesktopSidebarWidth("160"), DESKTOP_SIDEBAR_MIN_WIDTH);
  assert.equal(normalizeDesktopSidebarWidth("320"), 320);
  assert.equal(normalizeDesktopSidebarWidth("900"), DESKTOP_SIDEBAR_MAX_WIDTH);
});
