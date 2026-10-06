import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory } from "history";
import { App } from "../src/App";
import {
  mergeWorkspaceHistoryState,
  workspaceHistoryIndex,
  workspaceLocationFromHistory,
  workspacePathForRoute,
  workspaceRendererForViewport,
  workspaceRouteFromPathname,
} from "../src/workspace-routing";
import type { AppViewContextValue } from "../src/AppViewContext";

function installBrowserGlobals(viewportWidth: number, pathname = "/") {
  const keys = ["window", "document", "sessionStorage"] as const;
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const listeners = new Map<string, EventListener>();
  const browserWindow = {
    innerWidth: viewportWidth,
    location: { pathname, href: `http://localhost${pathname}` },
    history: {
      state: null,
      pushState() {},
      replaceState() {},
      back() {},
    },
    addEventListener(name: string, callback: EventListener) { listeners.set(name, callback); },
    removeEventListener(name: string) { listeners.delete(name); },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, activeElement: null },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem() { return null; }, setItem() {} },
  });

  return () => {
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

test("desktop renders the direct workspace without mounting Stackflow; mobile mounts Stackflow", async () => {
  const restoreDesktop = installBrowserGlobals(1280);
  try {
    const desktopHtml = renderToStaticMarkup(React.createElement(App));
    assert.match(desktopHtml, /data-fieldnotes-renderer="desktop"/);
    assert.doesNotMatch(desktopHtml, /class="[^"]*fieldnotes-stack(?:\s|")/);
  } finally {
    restoreDesktop();
  }

  const restoreMobile = installBrowserGlobals(390);
  try {
    const { MobileWorkspace } = await import("../src/stackflow");
    const value: AppViewContextValue = {
      currentRoute: { kind: "library" },
      navigation: { push() {}, replace() {}, pop() {}, canGoBack: false },
      renderWorkspace: (screen) => React.createElement("main", { "data-fieldnotes-route": screen.kind }, "Library"),
    };
    const mobileHtml = renderToStaticMarkup(React.createElement(MobileWorkspace, { value }));
    assert.match(mobileHtml, /data-fieldnotes-renderer="mobile-stackflow"/);
    assert.match(mobileHtml, /class="[^"]*fieldnotes-stack(?:\s|")/);
  } finally {
    restoreMobile();
  }
});

test("route selection switches at the desktop/mobile breakpoint while keeping deep links resolvable", () => {
  assert.equal(workspaceRendererForViewport(1280), "desktop");
  assert.equal(workspaceRendererForViewport(821), "desktop");
  assert.equal(workspaceRendererForViewport(820), "mobile-stackflow");
  assert.equal(workspaceRendererForViewport(390), "mobile-stackflow");
  assert.deepEqual(workspaceRouteFromPathname("/notes/9f0d"), { kind: "document", documentId: "9f0d" });
  assert.deepEqual(workspaceRouteFromPathname("/folders/Ideas%20%26%20Work"), {
    kind: "folder",
    folderId: "Ideas & Work",
  });
  assert.equal(workspacePathForRoute({ kind: "folder", folderId: "Ideas & Work" }), "/folders/Ideas%20%26%20Work");
});

test("native history back and forward restore the matching route and history index", async () => {
  const history = createMemoryHistory({
    initialEntries: [{ pathname: "/notes/note-a", state: mergeWorkspaceHistoryState({ preserved: "yes" }, 0) }],
  });
  history.push("/recent", mergeWorkspaceHistoryState(history.location.state, 1));
  history.push("/folders/reading", mergeWorkspaceHistoryState(history.location.state, 2));
  assert.equal((history.location.state as { preserved: string }).preserved, "yes");

  const readCurrent = () => workspaceLocationFromHistory(history.location.pathname, history.location.state);
  assert.deepEqual(readCurrent(), { route: { kind: "folder", folderId: "reading" }, historyIndex: 2 });
  history.back();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(readCurrent(), { route: { kind: "recent" }, historyIndex: 1 });
  history.back();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(readCurrent(), { route: { kind: "document", documentId: "note-a" }, historyIndex: 0 });
  history.forward();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(readCurrent(), { route: { kind: "recent" }, historyIndex: 1 });
  assert.equal(workspaceHistoryIndex({ fieldnotesNavigation: { index: -1 } }), null);
});
