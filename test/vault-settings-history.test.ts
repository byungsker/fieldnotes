import assert from "node:assert/strict";
import test from "node:test";
import { pushVaultSettingsHistoryEntry } from "../src/pages/workspace/model/vault-settings-history.js";

test("opening vault settings creates one history entry and preserves the current workspace state", () => {
  const initialState = {
    fieldnotesNavigation: { index: 2 },
    "fieldnotes:mobile-drawer": true,
  };
  const pushes: Array<{ state: unknown; title: string; url: string }> = [];
  const history = {
    state: initialState,
    pushState(state: unknown, title: string, url?: string | URL | null) {
      pushes.push({ state, title, url: String(url) });
    },
  };
  const entryRef = { current: false };
  const currentUrl = "http://127.0.0.1:4281/recent";

  pushVaultSettingsHistoryEntry(history, entryRef, currentUrl);
  pushVaultSettingsHistoryEntry(history, entryRef, currentUrl);

  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0], {
    state: { ...initialState, fieldnotesVaultSettings: true },
    title: "",
    url: currentUrl,
  });
  assert.equal(entryRef.current, true);
});
