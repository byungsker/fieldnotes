import assert from "node:assert/strict";
import test from "node:test";
import { createFieldnotesEditorAdapters } from "../src/editor-adapters.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

test("synthetic view trust survives adapter recreation for the same local identity and exact source", () => {
  const originalWindow = globalThis.window;
  const localStorage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });
  try {
    const documentId = "854f4505-9f35-4abc-8f9d-4202829f6d40";
    const sourceHash = "a".repeat(64);
    const firstAdapter = createFieldnotesEditorAdapters();
    assert.equal(firstAdapter.isVisualizationTrusted?.(documentId, 0, sourceHash), false);
    firstAdapter.trustVisualization?.(documentId, 0, sourceHash);

    const reopenedAdapter = createFieldnotesEditorAdapters();
    assert.equal(reopenedAdapter.isVisualizationTrusted?.(documentId, 0, sourceHash), true);
    assert.equal(reopenedAdapter.isVisualizationTrusted?.(documentId, 0, "b".repeat(64)), false);
    assert.equal(reopenedAdapter.isVisualizationTrusted?.(documentId, 1, sourceHash), false);
    assert.equal(reopenedAdapter.isVisualizationTrusted?.("a54f4505-9f35-4abc-8f9d-4202829f6d40", 0, sourceHash), false);
    reopenedAdapter.revokeVisualizationTrust?.(documentId, 0, sourceHash);
    assert.equal(createFieldnotesEditorAdapters().isVisualizationTrusted?.(documentId, 0, sourceHash), false);
  } finally {
    if (originalWindow === undefined) delete (globalThis as typeof globalThis & { window?: Window }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
