import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(path.join(projectRoot, "src/styles.css"), "utf8");
const mobileEditorStyles = readFileSync(path.join(projectRoot, "packages/markdown-live-editor/styles.css"), "utf8");
const appSource = readFileSync(path.join(projectRoot, "src/App.tsx"), "utf8");

test("mobile document and preview scrollers keep native iOS touch momentum", () => {
  assert.match(styles, /\.document-editor\s*\{[^}]*overflow-y:\s*auto;[^}]*-webkit-overflow-scrolling:\s*touch;/su);
  assert.match(styles, /\.preview-scroll\s*\{[^}]*-webkit-overflow-scrolling:\s*touch;/su);
  assert.match(mobileEditorStyles, /\.mle-fieldnotes-table-scroll\s*\{[^}]*overflow-x:\s*auto;[^}]*-webkit-overflow-scrolling:\s*touch;/su);
});

test("drawer gesture handling leaves document route touch scrolling to the browser", () => {
  const handlersStart = appSource.indexOf("const handleMobileTouchStart");
  const handlersEnd = appSource.indexOf("const handleSwipeClickCapture", handlersStart);
  assert.ok(handlersStart >= 0 && handlersEnd > handlersStart);
  const handlers = appSource.slice(handlersStart, handlersEnd);

  assert.match(handlers, /screen\.kind !== "library" && screen\.kind !== "folder"\) return;/u);
  assert.doesNotMatch(handlers, /preventDefault\s*\(/u);
});
