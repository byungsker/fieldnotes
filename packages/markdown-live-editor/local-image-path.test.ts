import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLocalImageAssetPath } from "./local-image-path.ts";

test("resolves preserved local image targets from the note to safe vault-root paths", () => {
  assert.equal(resolveLocalImageAssetPath("assets/cover.jpg", "reading/note.md"), "reading/assets/cover.jpg");
  assert.equal(resolveLocalImageAssetPath("../assets/cover.jpg", "reading/note.md"), "assets/cover.jpg");
  assert.equal(resolveLocalImageAssetPath("/assets/cover.png", "reading/note.md"), "assets/cover.png");
  assert.equal(resolveLocalImageAssetPath("photos/cover.webp|width=400", "reading/note.md"), "reading/photos/cover.webp");
  assert.equal(resolveLocalImageAssetPath("photos/cover.gif", "reading/note.md"), "reading/photos/cover.gif");
  assert.equal(resolveLocalImageAssetPath("photos/cover.avif", "reading/note.md"), "reading/photos/cover.avif");
});

test("rejects remote, escaping, hidden, malformed, and unsupported image sources", () => {
  assert.equal(resolveLocalImageAssetPath("https://example.test/photo.jpg", "reading/note.md"), null);
  assert.equal(resolveLocalImageAssetPath("//example.test/photo.jpg", "reading/note.md"), null);
  assert.equal(resolveLocalImageAssetPath("../../outside/photo.jpg", "reading/note.md"), null);
  assert.equal(resolveLocalImageAssetPath(".fieldnotes/private.png", "reading/note.md"), null);
  assert.equal(resolveLocalImageAssetPath("photo.svg", "reading/note.md"), null);
});
