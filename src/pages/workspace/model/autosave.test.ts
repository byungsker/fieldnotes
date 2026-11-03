import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalDraftQueue,
  localDraftKey,
  readLocalDraft,
  writeLocalDraft,
  type DraftStorage,
  type LocalDraftSnapshot,
} from "./autosave.ts";

class MemoryDraftStorage implements DraftStorage {
  values = new Map<string, string>();
  writes = 0;
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    if (this.failWrites) throw new Error("storage unavailable");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function draft(body: string, revision: number): LocalDraftSnapshot {
  return {
    documentId: "note-1",
    title: "Perf fixture",
    body,
    folderId: null,
    baseVersion: 1,
    baseHash: "fixture-hash",
    revision,
    pendingCreate: false,
    initialFolderId: null,
  };
}

test("rapid edits coalesce into one recovery write containing the latest body", async () => {
  const storage = new MemoryDraftStorage();
  const queue = new LocalDraftQueue(() => storage, undefined, 10);
  for (let revision = 1; revision <= 20; revision += 1) {
    queue.schedule(draft("x".repeat(500) + revision, revision));
  }

  assert.equal(storage.writes, 0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(storage.writes, 1);
  assert.equal(readLocalDraft("note-1", storage)?.body, "x".repeat(500) + 20);
});

test("flush writes immediately and cancels the delayed duplicate", async () => {
  const storage = new MemoryDraftStorage();
  const queue = new LocalDraftQueue(() => storage, undefined, 30);
  queue.schedule(draft("newest", 4));

  assert.equal(queue.flush("note-1"), true);
  assert.equal(storage.writes, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(storage.writes, 1);
  assert.equal(readLocalDraft("note-1", storage)?.body, "newest");
});

test("clear cancels pending recovery so stale text cannot return", async () => {
  const storage = new MemoryDraftStorage();
  assert.equal(writeLocalDraft(draft("saved", 1), storage), true);
  const queue = new LocalDraftQueue(() => storage, undefined, 20);
  queue.schedule(draft("stale unsaved", 2));

  assert.equal(queue.clear("note-1"), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(storage.getItem(localDraftKey("note-1")), null);
});

test("flush retries a failed write and preserves the pending latest snapshot", () => {
  const storage = new MemoryDraftStorage();
  storage.failWrites = true;
  const queue = new LocalDraftQueue(() => storage, undefined, 30);
  queue.schedule(draft("latest draft", 7));

  assert.equal(queue.flush("note-1"), false);
  storage.failWrites = false;
  assert.equal(queue.flush("note-1"), true);
  assert.equal(readLocalDraft("note-1", storage)?.body, "latest draft");
});

test("writeNow replaces a pending older snapshot", () => {
  const storage = new MemoryDraftStorage();
  const queue = new LocalDraftQueue(() => storage, undefined, 30);
  queue.schedule(draft("older", 1));

  assert.equal(queue.writeNow(draft("rebased latest", 2)), true);
  assert.equal(storage.writes, 1);
  assert.equal(readLocalDraft("note-1", storage)?.body, "rebased latest");
});

test("failed writeNow keeps the latest snapshot available for a lifecycle retry", () => {
  const storage = new MemoryDraftStorage();
  storage.failWrites = true;
  const queue = new LocalDraftQueue(() => storage, undefined, 30);

  assert.equal(queue.writeNow(draft("rebased latest", 2)), false);
  storage.failWrites = false;
  assert.equal(queue.flush("note-1"), true);
  assert.equal(readLocalDraft("note-1", storage)?.body, "rebased latest");
});
