import assert from "node:assert/strict";
import test from "node:test";
import { isSidebarToggleShortcut } from "../src/keyboard-shortcuts.ts";

test("Cmd+| matches the sidebar shortcut on Mac keyboards", () => {
  assert.equal(isSidebarToggleShortcut({ metaKey: true, ctrlKey: false, shiftKey: true, key: "|", code: "Backslash" }), true);
  assert.equal(isSidebarToggleShortcut({ metaKey: true, ctrlKey: false, shiftKey: true, key: "§", code: "Backslash" }), true);
});

test("the sidebar shortcut requires Command or Control plus Shift", () => {
  assert.equal(isSidebarToggleShortcut({ metaKey: true, ctrlKey: false, shiftKey: false, key: "|", code: "Backslash" }), false);
  assert.equal(isSidebarToggleShortcut({ metaKey: false, ctrlKey: false, shiftKey: true, key: "|", code: "Backslash" }), false);
  assert.equal(isSidebarToggleShortcut({ metaKey: false, ctrlKey: true, shiftKey: true, key: "|", code: "Backslash" }), true);
});
