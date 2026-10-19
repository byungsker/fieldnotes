import assert from "node:assert/strict";
import { test } from "node:test";
import { toggleFolderSubtree } from "../../src/pages/workspace/model/folder-tree";
import type { FolderRecord } from "../../src/pages/workspace/model/workspace-types";

function folder(id: string, parentId: string | null): FolderRecord {
  return { id, name: id, parentId, createdAt: "", updatedAt: "", version: 0, documentCount: 0 };
}

const folders = [
  folder("books", null),
  folder("fiction", "books"),
  folder("scifi", "fiction"),
  folder("nonfiction", "books"),
  folder("movies", null),
];

test("Alt-click collapse removes the selected folder and every expanded descendant", () => {
  const expanded = new Set(["books", "fiction", "scifi", "nonfiction", "movies"]);

  const next = toggleFolderSubtree(expanded, folders, "books");

  assert.deepEqual([...next].sort(), ["movies"]);
});

test("Alt-click expand opens every descendant while preserving unrelated folders", () => {
  const expanded = new Set(["fiction", "movies"]);

  const next = toggleFolderSubtree(expanded, folders, "books");

  assert.deepEqual([...next].sort(), ["books", "fiction", "movies", "nonfiction", "scifi"]);
});
