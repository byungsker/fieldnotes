import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearLocalDraft,
  draftMatchesDocument,
  isMeaningfulNewDraft,
  readLocalDraft,
  rebaseDraft,
  writeLocalDraft,
  type DraftStorage,
  type LocalDraftSnapshot,
} from "../src/autosave";

function memoryStorage(): DraftStorage {
  const data = new Map<string, string>();
  return {
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); },
    removeItem(key) { data.delete(key); },
  };
}

function snapshot(overrides: Partial<LocalDraftSnapshot> = {}): LocalDraftSnapshot {
  return {
    documentId: "note-1",
    title: "Untitled note",
    body: "",
    folderId: null,
    baseVersion: 0,
    baseHash: "",
    revision: 1,
    pendingCreate: true,
    initialFolderId: null,
    ...overrides,
  };
}

test("local drafts survive reload and are removed only after an explicit clear", () => {
  const storage = memoryStorage();
  const draft = snapshot({ title: "Writing", body: "Unsynced text", revision: 4 });
  assert.equal(writeLocalDraft(draft, storage), true);
  assert.deepEqual(readLocalDraft("note-1", storage), draft);
  assert.equal(readLocalDraft("other-note", storage), null);
  assert.equal(clearLocalDraft("note-1", storage), true);
  assert.equal(readLocalDraft("note-1", storage), null);
});

test("malformed browser draft data fails closed", () => {
  const storage = memoryStorage();
  storage.setItem("fieldnotes:draft:note-1", JSON.stringify({ documentId: "note-1", body: 9 }));
  assert.equal(readLocalDraft("note-1", storage), null);
});

test("empty pending note is not created until its first meaningful edit", () => {
  assert.equal(isMeaningfulNewDraft(snapshot()), false);
  assert.equal(isMeaningfulNewDraft(snapshot({ body: "  \n " })), false);
  assert.equal(isMeaningfulNewDraft(snapshot({ title: "A real title" })), true);
  assert.equal(isMeaningfulNewDraft(snapshot({ body: "First thought" })), true);
  assert.equal(isMeaningfulNewDraft(snapshot({ folderId: "folder-1" })), true);
});

test("a successful response rebases queued edits without replacing their source", () => {
  const draft = snapshot({ title: "Later title", body: "newer source", revision: 9 });
  const rebased = rebaseDraft(draft, { version: 4, contentHash: "hash-v4" });
  assert.equal(rebased.title, draft.title);
  assert.equal(rebased.body, draft.body);
  assert.equal(rebased.revision, draft.revision);
  assert.equal(rebased.baseVersion, 4);
  assert.equal(rebased.baseHash, "hash-v4");
  assert.equal(rebased.pendingCreate, false);
  assert.equal(draftMatchesDocument(rebased, { title: "Later title", body: "newer source", folderId: null }), true);
});
