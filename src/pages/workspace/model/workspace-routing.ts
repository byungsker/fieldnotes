export type WorkspaceRoute =
  | { kind: "library" }
  | { kind: "recent" }
  | { kind: "folder"; folderId: string }
  | { kind: "document"; documentId: string }
  | { kind: "not-found" };

type EmptyParams = Record<string, never>;

export type WorkspaceActivityParams = {
  Library: EmptyParams;
  Recent: EmptyParams;
  Folder: { folderId: string };
  Document: { documentId: string };
  NotFound: EmptyParams;
};

export type WorkspaceActivityName = keyof WorkspaceActivityParams;

export type WorkspaceNavigation = {
  push: <Name extends WorkspaceActivityName>(name: Name, params: WorkspaceActivityParams[Name]) => void;
  replace: <Name extends WorkspaceActivityName>(name: Name, params: WorkspaceActivityParams[Name]) => void;
  pop: () => void;
  canGoBack: boolean;
};

export const WORKSPACE_HISTORY_STATE_KEY = "fieldnotesNavigation";

export function workspaceHistoryState(index: number): Record<string, { index: number }> {
  return { [WORKSPACE_HISTORY_STATE_KEY]: { index } };
}

export function workspaceHistoryIndex(state: unknown): number | null {
  if (typeof state !== "object" || state === null || !(WORKSPACE_HISTORY_STATE_KEY in state)) return null;
  const value = (state as Record<string, unknown>)[WORKSPACE_HISTORY_STATE_KEY];
  if (typeof value !== "object" || value === null || !("index" in value)) return null;
  const index = (value as { index?: unknown }).index;
  return Number.isSafeInteger(index) && (index as number) >= 0 ? index as number : null;
}

export function workspaceLocationFromHistory(pathname: string, state: unknown): {
  route: WorkspaceRoute;
  historyIndex: number;
} {
  return {
    route: workspaceRouteFromPathname(pathname),
    historyIndex: workspaceHistoryIndex(state) ?? 0,
  };
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function workspaceRouteFromPathname(pathname: string): WorkspaceRoute {
  const segments = pathname.split("/").filter(Boolean).map(decodeSegment);
  if (segments.some((segment) => segment === null)) return { kind: "not-found" };
  const [first, second, ...extra] = segments as string[];
  if (first === undefined) return { kind: "library" };
  if (extra.length === 0 && first === "recent") return { kind: "recent" };
  if (extra.length === 0 && first === "folders" && second) return { kind: "folder", folderId: second };
  if (extra.length === 0 && first === "notes" && second) return { kind: "document", documentId: second };
  if (extra.length === 0 && first === "404" && second === undefined) return { kind: "not-found" };
  return { kind: "not-found" };
}

export function workspaceRouteForActivity<Name extends WorkspaceActivityName>(
  name: Name,
  params: WorkspaceActivityParams[Name],
): WorkspaceRoute {
  switch (name) {
    case "Library": return { kind: "library" };
    case "Recent": return { kind: "recent" };
    case "Folder": return { kind: "folder", folderId: (params as WorkspaceActivityParams["Folder"]).folderId };
    case "Document": return { kind: "document", documentId: (params as WorkspaceActivityParams["Document"]).documentId };
    case "NotFound": return { kind: "not-found" };
  }
}

export function workspacePathForActivity<Name extends WorkspaceActivityName>(
  name: Name,
  params: WorkspaceActivityParams[Name],
): string {
  switch (name) {
    case "Library": return "/";
    case "Recent": return "/recent";
    case "Folder": return `/folders/${encodeURIComponent((params as WorkspaceActivityParams["Folder"]).folderId)}`;
    case "Document": return `/notes/${encodeURIComponent((params as WorkspaceActivityParams["Document"]).documentId)}`;
    case "NotFound": return "/404";
  }
}

export function workspacePathForRoute(route: WorkspaceRoute): string {
  switch (route.kind) {
    case "library": return "/";
    case "recent": return "/recent";
    case "folder": return `/folders/${encodeURIComponent(route.folderId)}`;
    case "document": return `/notes/${encodeURIComponent(route.documentId)}`;
    case "not-found": return "/404";
  }
}

export function workspaceActivityForRoute(route: WorkspaceRoute): {
  name: WorkspaceActivityName;
  params: WorkspaceActivityParams[WorkspaceActivityName];
} {
  switch (route.kind) {
    case "library": return { name: "Library", params: {} };
    case "recent": return { name: "Recent", params: {} };
    case "folder": return { name: "Folder", params: { folderId: route.folderId } };
    case "document": return { name: "Document", params: { documentId: route.documentId } };
    case "not-found": return { name: "NotFound", params: {} };
  }
}

export function workspaceRoutesEqual(left: WorkspaceRoute, right: WorkspaceRoute): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "folder" && right.kind === "folder") return left.folderId === right.folderId;
  if (left.kind === "document" && right.kind === "document") return left.documentId === right.documentId;
  return true;
}

export function workspaceRendererForViewport(viewportWidth: number): "desktop" | "mobile-stackflow" {
  return viewportWidth <= 820 ? "mobile-stackflow" : "desktop";
}

export function usesMobileStackflow(viewportWidth: number): boolean {
  return workspaceRendererForViewport(viewportWidth) === "mobile-stackflow";
}

export function mergeWorkspaceHistoryState(state: unknown, index: number): Record<string, unknown> {
  const base = typeof state === "object" && state !== null && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {};
  return { ...base, ...workspaceHistoryState(index) };
}
