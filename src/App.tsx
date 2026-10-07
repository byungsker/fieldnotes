import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowDownUp,
  ArrowUpFromLine,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Eye,
  Link2,
  LoaderCircle,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Save,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { ApiError, apiRequest, jsonRequest } from "./api";
import { ActionDialog, type ActionDialogConfig, type ActionDialogResult } from "./ActionDialog";
import type { AppViewContextValue, WorkspaceScreen } from "./AppViewContext";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownLiveEditor } from "../packages/markdown-live-editor";
import { SearchHighlight } from "./SearchHighlight";
import { createFieldnotesEditorAdapters } from "./editor-adapters";
import { formatDocumentDate } from "./document-date";
import { resolveMobileDrawerSwipe, resolveMobileDrawerSwipeDrag } from "./mobile-drawer-swipe";
import type { ChangeRecord, DocumentRecord, DocumentSummary, FolderRecord } from "./types";
import {
  mergeWorkspaceHistoryState,
  workspaceHistoryIndex,
  workspaceLocationFromHistory,
  workspacePathForRoute,
  workspaceRendererForViewport,
  workspaceRouteForActivity,
  workspaceRouteFromPathname,
  workspaceRoutesEqual,
  type WorkspaceNavigation,
  type WorkspaceRoute,
} from "./workspace-routing";

type ConnectionState = "connecting" | "connected" | "reconnecting";
type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";
type DocumentListStatus = "loading" | "loaded" | "error";

type DocumentListResponse = { documents: DocumentSummary[] };
type DocumentResponse = { document: DocumentRecord };
type FolderListResponse = { folders: FolderRecord[] };
type FolderResponse = { folder: FolderRecord };
type RecentResponse = { changes: ChangeRecord[] };
type ChangesResponse = { changes: ChangeRecord[]; highWatermark: number };
type BacklinksResponse = { backlinks: DocumentSummary[] };

const LAST_SEQUENCE_KEY = "fieldnotes:last-change-sequence";
const THEME_KEY = "fieldnotes:theme";
const DESKTOP_SIDEBAR_KEY = "fieldnotes:desktop-sidebar-collapsed";
const DESKTOP_LIST_KEY = "fieldnotes:desktop-list-collapsed";
const MOBILE_DRAWER_HISTORY_KEY = "fieldnotes:mobile-drawer";
const MobileWorkspace = lazy(() => import("./stackflow").then((module) => ({ default: module.MobileWorkspace })));
type ActiveFolder = string | "root" | null;
type DraftSnapshot = { title: string; body: string; baseVersion: number };
type SortOrder = "updated-desc" | "updated-asc" | "title-asc" | "title-desc";
type ColorTheme = "dark" | "light";
type DocumentListScrollSnapshot = { documentId: string | null; itemOffset: number; scrollTop: number };
type MobileDrawerTouchStart = {
  identifier: number;
  startX: number;
  startY: number;
  drawerWasOpen: boolean;
  startedInDrawer: boolean;
  listRoute: boolean;
  viewportWidth: number;
  axis: "pending" | "horizontal" | "vertical" | "cancelled";
  direction: "open" | "close" | null;
  previewActive: boolean;
};

function hasMobileDrawerHistoryState(state: unknown): boolean {
  return typeof state === "object" && state !== null && !Array.isArray(state) &&
    (state as Record<string, unknown>)[MOBILE_DRAWER_HISTORY_KEY] === true;
}

function documentListViewKey(folderId: ActiveFolder, query: string, sortOrder: SortOrder): string {
  return JSON.stringify({ folderId, query, sortOrder });
}

function initialTheme(): ColorTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function initialDesktopSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(DESKTOP_SIDEBAR_KEY) === "true";
  } catch {
    return false;
  }
}

function initialDesktopListCollapsed(): boolean {
  try {
    return window.localStorage.getItem(DESKTOP_LIST_KEY) === "true";
  } catch {
    return false;
  }
}

function hasDraftChanged(document: DocumentRecord | null, title: string, body: string): boolean {
  return Boolean(document && (title !== document.title || body !== document.body));
}

function documentListPath(query: string, folderId: ActiveFolder): string {
  const parameters = new URLSearchParams();
  if (query.trim()) parameters.set("q", query.trim());
  if (folderId !== null) parameters.set("folderId", folderId);
  const suffix = parameters.toString();
  return `/api/documents${suffix ? `?${suffix}` : ""}`;
}

function folderPaths(folders: FolderRecord[]): Map<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string>();
  for (const folder of folders) {
    const chain: FolderRecord[] = [];
    const seen = new Set<string>();
    let cursor: FolderRecord | undefined = folder;
    while (cursor && !paths.has(cursor.id) && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      chain.push(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    let prefix = cursor ? paths.get(cursor.id) ?? "" : "";
    while (chain.length) {
      const part = chain.pop() as FolderRecord;
      prefix = prefix ? `${prefix} / ${part.name}` : part.name;
      paths.set(part.id, prefix);
    }
  }
  return paths;
}

function folderTreeRows(folders: FolderRecord[], expanded: Set<string>) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const children = new Map<string | null, FolderRecord[]>();
  for (const folder of folders) {
    const siblings = children.get(folder.parentId) ?? [];
    siblings.push(folder);
    children.set(folder.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left.name.localeCompare(right.name));

  const roots = [...(children.get(null) ?? [])];
  for (const folder of folders) {
    if (folder.parentId && !byId.has(folder.parentId)) roots.push(folder);
  }
  const stack = roots.reverse().map((folder) => ({ folder, depth: 0 }));
  const rows: Array<{ folder: FolderRecord; depth: number; hasChildren: boolean }> = [];
  const visited = new Set<string>();
  while (stack.length) {
    const current = stack.pop() as { folder: FolderRecord; depth: number };
    if (visited.has(current.folder.id)) continue;
    visited.add(current.folder.id);
    const nested = children.get(current.folder.id) ?? [];
    rows.push({ folder: current.folder, depth: current.depth, hasChildren: nested.length > 0 });
    if (expanded.has(current.folder.id)) {
      for (const folder of [...nested].reverse()) stack.push({ folder, depth: current.depth + 1 });
    }
  }
  return rows;
}

function descendantIds(folders: FolderRecord[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const list = children.get(folder.parentId) ?? [];
    list.push(folder.id);
    children.set(folder.parentId, list);
  }
  const descendants = new Set([id]);
  const stack = [id];
  while (stack.length) {
    for (const child of children.get(stack.pop() as string) ?? []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      stack.push(child);
    }
  }
  return descendants;
}

function relativeDate(value: string): string {
  const date = new Date(value);
  const elapsed = Date.now() - date.getTime();
  if (!Number.isFinite(elapsed)) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function operationLabel(operation: ChangeRecord["operation"]): string {
  if (operation === "created") return "created";
  if (operation === "deleted") return "deleted";
  return "updated";
}

function saveStateLabel(state: SaveState): string {
  if (state === "saved") return "Saved";
  if (state === "saving") return "Saving";
  if (state === "conflict") return "Conflict";
  if (state === "error") return "Not saved";
  return "Unsaved";
}

function initialSequence(): number {
  const value = Number(sessionStorage.getItem(LAST_SEQUENCE_KEY) ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function DocumentListSkeleton() {
  return (
    <div className="document-list-skeleton" role="status" aria-label="Loading notes" aria-busy="true">
      {Array.from({ length: 5 }, (_, index) => (
        <div className="document-skeleton-row" key={index} aria-hidden="true">
          <div className="document-skeleton-top">
            <span className="loading-skeleton document-skeleton-title" />
            <span className="loading-skeleton document-skeleton-date" />
          </div>
          <span className="loading-skeleton document-skeleton-excerpt" />
        </div>
      ))}
    </div>
  );
}

function WorkspaceLoadingSkeleton({ document = false }: { document?: boolean }) {
  return (
    <div
      className={`workspace-loading-skeleton${document ? " document-loading-skeleton" : ""}`}
      role="status"
      aria-label={document ? "Loading note" : "Loading your library"}
      aria-busy="true"
    >
      {document ? (
        <>
          <span className="loading-skeleton workspace-skeleton-title" aria-hidden="true" />
          <div className="workspace-skeleton-properties" aria-hidden="true">
            <span className="loading-skeleton" />
            <span className="loading-skeleton" />
            <span className="loading-skeleton" />
          </div>
          <span className="loading-skeleton workspace-skeleton-divider" aria-hidden="true" />
          <div className="workspace-skeleton-body" aria-hidden="true">
            <span className="loading-skeleton" />
            <span className="loading-skeleton" />
            <span className="loading-skeleton" />
            <span className="loading-skeleton" />
          </div>
        </>
      ) : (
        <>
          <span className="loading-skeleton workspace-skeleton-art" aria-hidden="true" />
          <span className="loading-skeleton workspace-skeleton-kicker" aria-hidden="true" />
          <span className="loading-skeleton workspace-skeleton-heading" aria-hidden="true" />
          <span className="loading-skeleton workspace-skeleton-copy" aria-hidden="true" />
          <span className="loading-skeleton workspace-skeleton-copy short" aria-hidden="true" />
        </>
      )}
    </div>
  );
}

export function App() {
  const [currentRoute, setCurrentRoute] = useState<WorkspaceRoute>(() => workspaceRouteFromPathname(window.location.pathname));
  const initialHistoryIndex = workspaceHistoryIndex(window.history.state) ?? 0;
  const [historyIndex, setHistoryIndex] = useState(initialHistoryIndex);
  const [workspaceRenderer, setWorkspaceRenderer] = useState(() => workspaceRendererForViewport(window.innerWidth));
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [visibleDocuments, setVisibleDocuments] = useState<DocumentSummary[]>([]);
  const [documentListStatus, setDocumentListStatus] = useState<DocumentListStatus>("loading");
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<ActiveFolder>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => new Set());
  const [creatingFolderParent, setCreatingFolderParent] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState("");
  const [recentChanges, setRecentChanges] = useState<ChangeRecord[]>([]);
  const [backlinks, setBacklinks] = useState<DocumentSummary[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<DocumentRecord | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const editorAdapters = useMemo(() => createFieldnotesEditorAdapters(), []);
  const [query, setQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("updated-desc");
  const [theme, setTheme] = useState<ColorTheme>(initialTheme);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(initialDesktopSidebarCollapsed);
  const [desktopListCollapsed, setDesktopListCollapsed] = useState(initialDesktopListCollapsed);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [externalVersion, setExternalVersion] = useState<number | null>(null);
  const [externalDelete, setExternalDelete] = useState(false);
  const [activeView, setActiveView] = useState<"write" | "preview">("write");
  const [notice, setNotice] = useState("");
  const [listError, setListError] = useState("");
  const [importing, setImporting] = useState(false);
  const [actionDialog, setActionDialog] = useState<ActionDialogConfig | null>(null);
  const [routeError, setRouteError] = useState("");
  const [documentLoadError, setDocumentLoadError] = useState<{ documentId: string; message: string } | null>(null);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(() => hasMobileDrawerHistoryState(window.history.state));
  const [mobileDrawerSwipePreview, setMobileDrawerSwipePreview] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const notesHeadingRef = useRef<HTMLHeadingElement>(null);
  const actionDialogRef = useRef(actionDialog);
  const activeViewRef = useRef(activeView);
  const selectedRef = useRef<DocumentRecord | null>(null);
  const draftTitleRef = useRef("");
  const draftBodyRef = useRef("");
  const queryRef = useRef("");
  const activeFolderRef = useRef<ActiveFolder>(null);
  const sequenceRef = useRef(initialSequence());
  const reconcilingRef = useRef(false);
  const searchRequestRef = useRef(0);
  const documentsLoadedRef = useRef(false);
  const folderTreeInitializedRef = useRef(false);
  const draftsRef = useRef(new Map<string, DraftSnapshot>());
  const dialogResolverRef = useRef<((result: ActionDialogResult) => void) | null>(null);
  const navigationPendingRef = useRef(false);
  const historyIndexRef = useRef(initialHistoryIndex);
  const currentRouteRef = useRef(currentRoute);
  const workspaceRendererRef = useRef(workspaceRenderer);
  const activeActivityIdRef = useRef("desktop");
  const editorWasFocusedBeforeResizeRef = useRef(false);
  const drawerHistoryEntryRef = useRef(hasMobileDrawerHistoryState(window.history.state));
  const pendingDrawerNavigationRef = useRef<{ route: WorkspaceRoute; mode: "push" | "replace" } | null>(null);
  const drawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const drawerWasOpenRef = useRef(hasMobileDrawerHistoryState(window.history.state));
  const mobileDrawerTouchStartRef = useRef<MobileDrawerTouchStart | null>(null);
  const suppressSwipeClickRef = useRef(false);
  const suppressSwipeClickTimerRef = useRef<number | null>(null);
  const drawerSwipeCloseTimerRef = useRef<number | null>(null);
  const drawerSwipeResetTimerRef = useRef<number | null>(null);
  const documentListScrollRef = useRef(new Map<string, DocumentListScrollSnapshot>());
  const currentListViewKey = documentListViewKey(activeFolderId, query, sortOrder);
  const currentListViewKeyRef = useRef(currentListViewKey);

  selectedRef.current = selectedDocument;
  draftTitleRef.current = draftTitle;
  draftBodyRef.current = draftBody;
  queryRef.current = query;
  activeFolderRef.current = activeFolderId;
  actionDialogRef.current = actionDialog;
  activeViewRef.current = activeView;
  currentRouteRef.current = currentRoute;
  workspaceRendererRef.current = workspaceRenderer;
  currentListViewKeyRef.current = currentListViewKey;

  const storeDocumentListScroll = useCallback((list: HTMLElement) => {
    if (workspaceRendererRef.current !== "mobile-stackflow") return;
    if (!list.getClientRects().length) return;
    const activeRoot = list.closest<HTMLElement>(".app-shell");
    if (
      !activeRoot ||
      activeRoot.id !== "fieldnotes-activity-" + activeActivityIdRef.current ||
      (activeRoot.dataset.fieldnotesRoute !== "library" && activeRoot.dataset.fieldnotesRoute !== "folder")
    ) return;
    const listRect = list.getBoundingClientRect();
    const firstVisible = Array.from(list.querySelectorAll<HTMLElement>("[data-document-id]"))
      .find((row) => row.getBoundingClientRect().bottom > listRect.top);
    documentListScrollRef.current.set(list.dataset.listViewKey ?? currentListViewKeyRef.current, {
      documentId: firstVisible?.dataset.documentId ?? null,
      itemOffset: firstVisible ? firstVisible.getBoundingClientRect().top - listRect.top : 0,
      scrollTop: list.scrollTop,
    });
  }, []);

  const saveActiveDocumentListScroll = useCallback(() => {
    if (workspaceRendererRef.current !== "mobile-stackflow") return;
    const activeRoot = document.getElementById("fieldnotes-activity-" + activeActivityIdRef.current);
    const list = activeRoot?.querySelector<HTMLElement>(".document-list");
    if (list) storeDocumentListScroll(list);
  }, [storeDocumentListScroll]);

  const restoreDocumentListScroll = useCallback((list: HTMLElement) => {
    const snapshot = documentListScrollRef.current.get(list.dataset.listViewKey ?? currentListViewKeyRef.current);
    if (!snapshot) return;
    const anchor = snapshot.documentId
      ? Array.from(list.querySelectorAll<HTMLElement>("[data-document-id]"))
        .find((row) => row.dataset.documentId === snapshot.documentId)
      : null;
    if (anchor) {
      const currentOffset = anchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
      list.scrollTop += currentOffset - snapshot.itemOffset;
    } else {
      list.scrollTop = snapshot.scrollTop;
    }
  }, []);

  const restoreMobileListScroll = useCallback((activityId: string) => {
    const activeRoot = document.getElementById("fieldnotes-activity-" + activityId);
    if (activeRoot?.dataset.fieldnotesRoute !== "library" && activeRoot?.dataset.fieldnotesRoute !== "folder") return;
    const list = activeRoot.querySelector<HTMLElement>(".document-list");
    if (list) restoreDocumentListScroll(list);
  }, [restoreDocumentListScroll]);

  const openMobileDrawer = useCallback((returnFocusTarget: HTMLElement | null) => {
    if (workspaceRendererRef.current !== "mobile-stackflow") return;
    drawerReturnFocusRef.current = returnFocusTarget;
    if (!drawerHistoryEntryRef.current) {
      const currentState = window.history.state;
      const base = typeof currentState === "object" && currentState !== null && !Array.isArray(currentState)
        ? currentState as Record<string, unknown>
        : {};
      window.history.pushState(
        { ...base, [MOBILE_DRAWER_HISTORY_KEY]: true },
        "",
        window.location.href,
      );
      drawerHistoryEntryRef.current = true;
    }
    drawerWasOpenRef.current = true;
    setMobileDrawerOpen(true);
  }, []);

  const closeMobileDrawer = useCallback(() => {
    if (drawerHistoryEntryRef.current) {
      window.history.back();
      return;
    }
    if (workspaceRendererRef.current !== "mobile-stackflow") return;
    setMobileDrawerOpen(false);
  }, []);

  const navigateRoute = useCallback((route: WorkspaceRoute, mode: "push" | "replace" = "push") => {
    saveActiveDocumentListScroll();
    if (drawerHistoryEntryRef.current) {
      pendingDrawerNavigationRef.current = { route, mode };
      window.history.back();
      return;
    }
    const nextIndex = mode === "push" ? historyIndexRef.current + 1 : historyIndexRef.current;
    const state = mergeWorkspaceHistoryState(window.history.state, nextIndex);
    window.history[mode === "push" ? "pushState" : "replaceState"](state, "", workspacePathForRoute(route));
    historyIndexRef.current = nextIndex;
    setHistoryIndex(nextIndex);
    setCurrentRoute(route);
  }, [saveActiveDocumentListScroll]);

  const navigation = useMemo<WorkspaceNavigation>(() => ({
    push(name, params) {
      navigateRoute(workspaceRouteForActivity(name, params));
    },
    replace(name, params) {
      navigateRoute(workspaceRouteForActivity(name, params), "replace");
    },
    pop() {
      if (drawerHistoryEntryRef.current) {
        closeMobileDrawer();
        return;
      }
      if (historyIndexRef.current > 0) window.history.back();
      else navigateRoute({ kind: "library" }, "replace");
    },
    canGoBack: historyIndex > 0,
  }), [closeMobileDrawer, historyIndex, navigateRoute]);

  useEffect(() => {
    const existingIndex = workspaceHistoryIndex(window.history.state);
    const index = existingIndex ?? 0;
    if (existingIndex === null) {
      window.history.replaceState(
        mergeWorkspaceHistoryState(window.history.state, index),
        "",
        window.location.href,
      );
    }
    historyIndexRef.current = index;

    const handlePopState = (event: PopStateEvent) => {
      if (hasMobileDrawerHistoryState(event.state)) {
        drawerHistoryEntryRef.current = true;
        drawerWasOpenRef.current = true;
        setMobileDrawerOpen(true);
        return;
      }
      const closedDrawer = drawerHistoryEntryRef.current;
      drawerHistoryEntryRef.current = false;
      const next = workspaceLocationFromHistory(window.location.pathname, event.state);
      historyIndexRef.current = next.historyIndex;
      setHistoryIndex(next.historyIndex);
      if (closedDrawer) setMobileDrawerOpen(false);
      const pendingNavigation = pendingDrawerNavigationRef.current;
      if (closedDrawer && pendingNavigation) {
        pendingDrawerNavigationRef.current = null;
        navigateRoute(pendingNavigation.route, pendingNavigation.mode);
        return;
      }
      setCurrentRoute(next.route);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [navigateRoute]);

  useEffect(() => {
    if (workspaceRenderer !== "mobile-stackflow" || !mobileDrawerOpen) {
      if (drawerWasOpenRef.current && !mobileDrawerOpen) {
        drawerWasOpenRef.current = false;
        window.requestAnimationFrame(() => {
          const trigger = drawerReturnFocusRef.current;
          const triggerWorkspace = trigger?.closest<HTMLElement>(".app-shell");
          if (
            trigger?.isConnected &&
            trigger.getClientRects().length > 0 &&
            triggerWorkspace?.id === "fieldnotes-activity-" + activeActivityIdRef.current
          ) {
            trigger.focus({ preventScroll: true });
            return;
          }
          const activeWorkspace = document.getElementById("fieldnotes-activity-" + activeActivityIdRef.current);
          const fallback = activeWorkspace?.querySelector<HTMLElement>(".workspace-title") ??
            activeWorkspace?.querySelector<HTMLElement>("h1") ??
            activeWorkspace?.querySelector<HTMLElement>(".editor-pane");
          fallback?.focus({ preventScroll: true });
        });
      }
      return;
    }

    drawerWasOpenRef.current = true;
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    const activeWorkspace = document.getElementById("fieldnotes-activity-" + activeActivityIdRef.current);
    const findDrawer = () => activeWorkspace?.querySelector<HTMLElement>(
      ".mobile-navigation-drawer:not([hidden])",
    ) ?? null;
    const backgroundElements = Array.from(activeWorkspace?.querySelectorAll<HTMLElement>(
      ".mobile-topbar, .note-column, .editor-pane",
    ) ?? []);
    const previousAriaHidden = new Map<HTMLElement, string | null>();
    for (const element of backgroundElements) {
      previousAriaHidden.set(element, element.getAttribute("aria-hidden"));
      element.setAttribute("aria-hidden", "true");
    }
    const focusFrame = window.requestAnimationFrame(() => {
      const drawer = findDrawer();
      const closeButton = drawer?.querySelector<HTMLElement>(".mobile-drawer-close");
      (closeButton ?? drawer)?.focus({ preventScroll: true });
    });
    const onDrawerKeyDown = (event: KeyboardEvent) => {
      const drawer = findDrawer();
      if (!drawer) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobileDrawer();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        drawer.focus({ preventScroll: true });
      } else if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onDrawerKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onDrawerKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      for (const [element, previousValue] of previousAriaHidden) {
        if (previousValue === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", previousValue);
      }
    };
  }, [closeMobileDrawer, mobileDrawerOpen, workspaceRenderer]);

  const requestActionDialog = useCallback((config: ActionDialogConfig) => new Promise<ActionDialogResult>((resolve) => {
    dialogResolverRef.current = resolve;
    setActionDialog(config);
  }), []);
  const requestConfirm = useCallback(async (config: Omit<Extract<ActionDialogConfig, { kind: "confirm" }>, "kind">) => {
    return (await requestActionDialog({ kind: "confirm", ...config })) === true;
  }, [requestActionDialog]);
  const requestText = useCallback(async (config: Omit<Extract<ActionDialogConfig, { kind: "prompt" }>, "kind">) => {
    const result = await requestActionDialog({ kind: "prompt", ...config });
    return typeof result === "string" ? result : null;
  }, [requestActionDialog]);
  const resolveActionDialog = useCallback((result: ActionDialogResult) => {
    const resolve = dialogResolverRef.current;
    dialogResolverRef.current = null;
    setActionDialog(null);
    resolve?.(result);
  }, []);
  const rememberDraft = useCallback((document: DocumentRecord | null, title: string, body: string) => {
    if (!document) return;
    if (!hasDraftChanged(document, title, body)) {
      draftsRef.current.delete(document.id);
      return;
    }
    draftsRef.current.set(document.id, { title, body, baseVersion: document.version });
  }, []);

  const isDirty = Boolean(
    selectedDocument &&
      (draftTitle !== selectedDocument.title || draftBody !== selectedDocument.body),
  );
  const folderPathById = useMemo(() => folderPaths(folders), [folders]);
  const orderedDocuments = useMemo(() => {
    const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    return [...visibleDocuments].sort((left, right) => {
      if (sortOrder === "title-asc" || sortOrder === "title-desc") {
        const titleOrder = collator.compare(left.title, right.title);
        return (sortOrder === "title-asc" ? titleOrder : -titleOrder) || left.id.localeCompare(right.id);
      }
      const updatedOrder = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
      if (updatedOrder !== 0) return sortOrder === "updated-asc" ? updatedOrder : -updatedOrder;
      return collator.compare(left.title, right.title) || left.id.localeCompare(right.id);
    });
  }, [sortOrder, visibleDocuments]);

  useEffect(() => {
    if (workspaceRenderer !== "mobile-stackflow") return;
    if (currentRoute.kind !== "library" && currentRoute.kind !== "folder") return;
    let frame = 0;
    let attempts = 0;
    const restoreWhenActiveScreenIsReady = () => {
      const activeRoot = document.getElementById("fieldnotes-activity-" + activeActivityIdRef.current);
      const list = activeRoot?.querySelector<HTMLElement>(".document-list");
      if (list && activeRoot?.dataset.fieldnotesRoute === currentRoute.kind) {
        restoreDocumentListScroll(list);
        return;
      }
      if (++attempts < 30) frame = window.requestAnimationFrame(restoreWhenActiveScreenIsReady);
    };
    frame = window.requestAnimationFrame(restoreWhenActiveScreenIsReady);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeFolderId, currentListViewKey, currentRoute, orderedDocuments, restoreDocumentListScroll, sortOrder, workspaceRenderer]);

  const visibleFolderRows = useMemo(
    () => folderTreeRows(folders, expandedFolderIds),
    [expandedFolderIds, folders],
  );
  const activeFolder = activeFolderId && activeFolderId !== "root"
    ? folders.find((folder) => folder.id === activeFolderId) ?? null
    : null;
  const excludedFolderParents = useMemo(
    () => activeFolder ? descendantIds(folders, activeFolder.id) : new Set<string>(),
    [activeFolder, folders],
  );

  const refreshDocuments = useCallback(async () => {
    const requestId = ++searchRequestRef.current;
    if (!documentsLoadedRef.current) {
      setDocumentListStatus("loading");
      setListError("");
    }
    try {
      const response = await apiRequest<DocumentListResponse>("/api/documents");
      setDocuments(response.documents);
      const currentQuery = queryRef.current;
      const currentFolder = activeFolderRef.current;
      if (!currentQuery.trim() && currentFolder === null) {
        if (requestId === searchRequestRef.current) setVisibleDocuments(response.documents);
      } else {
        const search = await apiRequest<DocumentListResponse>(documentListPath(currentQuery, currentFolder));
        if (requestId === searchRequestRef.current) setVisibleDocuments(search.documents);
      }
      setListError("");
      documentsLoadedRef.current = true;
      setDocumentListStatus("loaded");
    } catch (error) {
      if (!documentsLoadedRef.current) setDocumentListStatus("error");
      throw error;
    }
  }, []);

  const refreshFolders = useCallback(async () => {
    const response = await apiRequest<FolderListResponse>("/api/folders");
    setFolders(response.folders);
    if (!folderTreeInitializedRef.current) {
      folderTreeInitializedRef.current = true;
      setExpandedFolderIds(new Set(response.folders.filter((folder) => folder.parentId === null).map((folder) => folder.id)));
    }
    if (activeFolderRef.current !== null && activeFolderRef.current !== "root" &&
      !response.folders.some((folder) => folder.id === activeFolderRef.current)) {
      activeFolderRef.current = null;
      setActiveFolderId(null);
    }
  }, []);

  const refreshSearch = useCallback(async (value: string) => {
    if (!documentsLoadedRef.current) return;
    const requestId = ++searchRequestRef.current;
    const currentFolder = activeFolderRef.current;
    if (!value.trim() && currentFolder === null) {
      setVisibleDocuments(documents);
      setListError("");
      return;
    }
    try {
      const response = await apiRequest<DocumentListResponse>(documentListPath(value, currentFolder));
      if (requestId === searchRequestRef.current) {
        setVisibleDocuments(response.documents);
        setListError("");
      }
    } catch (error) {
      if (requestId === searchRequestRef.current) {
        setListError(error instanceof Error ? error.message : "Search is unavailable.");
      }
    }
  }, [documents]);

  const refreshRecent = useCallback(async () => {
    const response = await apiRequest<RecentResponse>("/api/changes/recent?limit=18");
    setRecentChanges(response.changes);
  }, []);

  const refreshBacklinks = useCallback(async (id: string) => {
    try {
      const response = await apiRequest<BacklinksResponse>(`/api/backlinks/${id}`);
      if (selectedRef.current?.id === id) setBacklinks(response.backlinks);
    } catch {
      if (selectedRef.current?.id === id) setBacklinks([]);
    }
  }, []);

  const acceptDocument = useCallback((
    document: DocumentRecord,
    restoreDraft = true,
    view: "write" | "preview" = "preview",
  ) => {
    setDocumentLoadError(null);
    const cachedDraft = restoreDraft ? draftsRef.current.get(document.id) : undefined;
    if (!restoreDraft) draftsRef.current.delete(document.id);
    selectedRef.current = document;
    setSelectedDocument(document);
    setDraftTitle(cachedDraft?.title ?? document.title);
    setDraftBody(cachedDraft?.body ?? document.body);
    const versionChanged = Boolean(cachedDraft && cachedDraft.baseVersion !== document.version);
    setSaveState(versionChanged ? "conflict" : cachedDraft ? "unsaved" : "saved");
    setExternalVersion(versionChanged ? document.version : null);
    setExternalDelete(false);
    setBacklinks([]);
    activeViewRef.current = view;
    setActiveView(view);
    setNotice(versionChanged
      ? "A newer version was saved elsewhere. Your draft is still here."
      : cachedDraft ? "Unsaved draft restored in this tab." : "");
  }, []);

  const ensureDocumentForRoute = useCallback(async (id: string) => {
    if (selectedRef.current?.id === id) {
      setDocumentLoadError(null);
      setRouteError("");
      return;
    }
    setDocumentLoadError(null);
    setRouteError("");
    try {
      const response = await apiRequest<DocumentResponse>(`/api/documents/${id}`);
      if (currentRouteRef.current.kind !== "document" || currentRouteRef.current.documentId !== id) return;
      setRouteError("");
      acceptDocument(response.document);
      void refreshBacklinks(response.document.id);
    } catch {
      if (currentRouteRef.current.kind === "document" && currentRouteRef.current.documentId === id) {
        setDocumentLoadError({ documentId: id, message: "This note could not be found. It may have been deleted." });
      }
    }
  }, [acceptDocument, refreshBacklinks]);

  const applyIncomingChange = useCallback(async (change: ChangeRecord) => {
    if (change.seq <= sequenceRef.current) return;
    sequenceRef.current = change.seq;
    sessionStorage.setItem(LAST_SEQUENCE_KEY, String(change.seq));

    void refreshDocuments().catch(() => setListError("The note list is temporarily unavailable."));
    void refreshFolders().catch(() => setListError("The folder list is temporarily unavailable."));
    void refreshRecent().catch(() => undefined);

    if (change.entityType === "folder") {
      if (change.operation === "deleted" && activeFolderRef.current === change.folderId) {
        activeFolderRef.current = null;
        setActiveFolderId(null);
      }
      return;
    }
    if (!change.documentId) return;

    const selected = selectedRef.current;
    if (!selected || selected.id !== change.documentId) return;

    if (change.operation === "deleted") {
      const dirty = draftTitleRef.current !== selected.title || draftBodyRef.current !== selected.body;
      if (dirty) {
        setExternalDelete(true);
        setSaveState("conflict");
        setNotice("This note was deleted on another client. Your draft is still here.");
      } else {
        selectedRef.current = null;
        setSelectedDocument(null);
        setBacklinks([]);
        setDocumentLoadError({ documentId: selected.id, message: "This note was deleted elsewhere." });
        setNotice("This note was deleted on another client.");
      }
      return;
    }

    try {
      const response = await apiRequest<DocumentResponse>(`/api/documents/${change.documentId}`);
      const current = selectedRef.current;
      if (!current || current.id !== change.documentId) return;
      const dirty = draftTitleRef.current !== current.title || draftBodyRef.current !== current.body;
      if (dirty) {
        setExternalVersion(response.document.version);
        setSaveState("conflict");
        setNotice("A newer version was saved elsewhere. Your draft is still here.");
      } else {
        acceptDocument(response.document, true, activeViewRef.current);
        void refreshBacklinks(response.document.id);
      }
    } catch {
      // A later reconciliation or delete event will resolve this race.
    }
  }, [acceptDocument, refreshBacklinks, refreshDocuments, refreshFolders, refreshRecent]);

  const reconcileChanges = useCallback(async () => {
    if (reconcilingRef.current) return;
    reconcilingRef.current = true;
    try {
      let more = true;
      while (more) {
        const response = await apiRequest<ChangesResponse>(`/api/changes?after=${sequenceRef.current}`);
        if (response.highWatermark < sequenceRef.current) {
          sequenceRef.current = 0;
          sessionStorage.setItem(LAST_SEQUENCE_KEY, "0");
          more = true;
          continue;
        }
        for (const change of response.changes) await applyIncomingChange(change);
        more = response.changes.length === 500 && sequenceRef.current < response.highWatermark;
      }
      await Promise.all([refreshDocuments(), refreshFolders(), refreshRecent()]);
      setConnection("connected");
    } catch {
      setConnection("reconnecting");
    } finally {
      reconcilingRef.current = false;
    }
  }, [applyIncomingChange, refreshDocuments, refreshFolders, refreshRecent]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial list loads synchronize the UI with the API.
    void refreshDocuments().catch(() => setListError("The local service is unavailable. Reconnecting…"));
    void refreshFolders().catch(() => setListError("The folder list is temporarily unavailable."));
    void refreshRecent().catch(() => undefined);

    const source = new EventSource(`/api/events?after=${sequenceRef.current}`);
    source.onopen = () => {
      setConnection("connected");
      void reconcileChanges();
    };
    source.onerror = () => setConnection("reconnecting");
    source.addEventListener("change", (event) => {
      try {
        void applyIncomingChange(JSON.parse((event as MessageEvent<string>).data) as ChangeRecord);
      } catch {
        setConnection("reconnecting");
      }
    });
    source.addEventListener("ready", () => setConnection("connected"));
    return () => source.close();
  }, [applyIncomingChange, reconcileChanges, refreshDocuments, refreshFolders, refreshRecent]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshSearch(query), 180);
    return () => window.clearTimeout(timer);
  }, [activeFolderId, query, refreshSearch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || actionDialogRef.current) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("dialog[open], [role='dialog']")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveDocument();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.repeat && event.key.toLowerCase() === "e") {
        if (!selectedRef.current) return;
        if (target?.closest("input:not(.title-input), select, [contenteditable='true']")) return;
        event.preventDefault();
        switchEditorView(activeViewRef.current === "write" ? "preview" : "write");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // saveDocument reads current values through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveDocument() {
    const selected = selectedRef.current;
    if (!selected) return;
    const title = draftTitleRef.current.trim();
    const body = draftBodyRef.current;
    if (!title) {
      setSaveState("error");
      setNotice("Give this note a title before saving.");
      return;
    }
    setSaveState("saving");
    setNotice("");
    try {
      const response = await apiRequest<DocumentResponse>(
        `/api/documents/${selected.id}`,
        jsonRequest("PUT", { expectedVersion: selected.version, title, body }),
      );
      acceptDocument(response.document, false, activeViewRef.current);
      await Promise.all([refreshDocuments(), refreshRecent(), refreshBacklinks(response.document.id)]);
      setNotice("Saved to this Mac.");
    } catch (error) {
      if (error instanceof ApiError && error.code === "version_conflict") {
        setSaveState("conflict");
        setExternalVersion(error.currentVersion ?? null);
        setNotice("This note changed on another client. Your draft is still here.");
      } else {
        setSaveState("error");
        setNotice(error instanceof Error ? error.message : "Could not save this note.");
      }
    }
  }

  const createNote = async (): Promise<DocumentRecord | null> => {
    if (isDirty && !await requestConfirm({
      title: "Discard this draft?",
      description: "The unsaved changes in this note will be discarded when the new note opens.",
      confirmLabel: "Discard draft",
      destructive: true,
    })) return null;
    if (isDirty && selectedDocument) draftsRef.current.delete(selectedDocument.id);
    try {
      const folderId = activeFolderId && activeFolderId !== "root" ? activeFolderId : null;
      const response = await apiRequest<DocumentResponse>("/api/documents", jsonRequest("POST", { title: "Untitled note", body: "", folderId }));
      acceptDocument(response.document, true, "write");
      await Promise.all([refreshDocuments(), refreshFolders(), refreshRecent()]);
      void refreshBacklinks(response.document.id);
      return response.document;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not create a note.");
      return null;
    }
  };

  const openDocument = async (id: string): Promise<boolean> => {
    const selected = selectedRef.current;
    if (selected?.id === id) return true;
    const dirty = hasDraftChanged(selected, draftTitleRef.current, draftBodyRef.current);
    if (dirty && !await requestConfirm({
      title: "Discard this draft?",
      description: "The unsaved changes in this note will be discarded when the other note opens.",
      confirmLabel: "Discard draft",
      destructive: true,
    })) return false;
    if (dirty && selected) draftsRef.current.delete(selected.id);
    try {
      const response = await apiRequest<DocumentResponse>(`/api/documents/${id}`);
      acceptDocument(response.document);
      void refreshBacklinks(response.document.id);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not open this note.");
      return false;
    }
  };

  const deleteCurrentDocument = async (): Promise<boolean> => {
    const selected = selectedRef.current;
    if (!selected) return false;
    if (!await requestConfirm({
      title: `Delete “${selected.title}”?`,
      description: "This note and its history entry cannot be restored from inside Fieldnotes.",
      confirmLabel: "Delete note",
      destructive: true,
    })) return false;
    try {
      await apiRequest<void>(`/api/documents/${selected.id}`, jsonRequest("DELETE", { expectedVersion: selected.version }));
      draftsRef.current.delete(selected.id);
      selectedRef.current = null;
      setSelectedDocument(null);
      setBacklinks([]);
      setNotice("Note deleted.");
      await Promise.all([refreshDocuments(), refreshFolders(), refreshRecent()]);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "version_conflict") {
        setSaveState("conflict");
        setExternalVersion(error.currentVersion ?? null);
        setNotice("This note changed elsewhere and was not deleted. Load the latest version first.");
      } else {
        setNotice(error instanceof Error ? error.message : "Could not delete this note.");
      }
      return false;
    }
  };

  const loadLatestVersion = async () => {
    const selected = selectedRef.current;
    if (!selected) return;
    if (externalDelete) {
      draftsRef.current.delete(selected.id);
      selectedRef.current = null;
      setSelectedDocument(null);
      setBacklinks([]);
      setExternalDelete(false);
      setNotice("The deleted note and its draft were closed.");
      return;
    }
    try {
      const response = await apiRequest<DocumentResponse>(`/api/documents/${selected.id}`);
      acceptDocument(response.document, false, activeViewRef.current);
      void refreshBacklinks(response.document.id);
      setNotice("Loaded the latest version.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load the latest version.");
    }
  };

  const importMarkdown = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length) return;
    if (isDirty && !await requestConfirm({
      title: "Discard this draft and import?",
      description: "The imported Markdown notes will open after the current unsaved changes are discarded.",
      confirmLabel: "Discard and import",
      destructive: true,
    })) return;
    if (isDirty && selectedDocument) draftsRef.current.delete(selectedDocument.id);
    setImporting(true);
    setNotice("");
    try {
      const documentsToImport = await Promise.all(
        files.map(async (file) => {
          const filename = file.name.replace(/\.(markdown|md)$/i, "").trim();
          const folderId = activeFolderId && activeFolderId !== "root" ? activeFolderId : null;
          return { title: filename || "Imported note", body: await file.text(), folderId };
        }),
      );
      const response = await apiRequest<{ documents: DocumentRecord[] }>(
        "/api/import",
        jsonRequest("POST", { documents: documentsToImport }),
      );
      await Promise.all([refreshDocuments(), refreshFolders(), refreshRecent()]);
      if (response.documents[0]) {
        acceptDocument(response.documents[0]);
        void refreshBacklinks(response.documents[0].id);
      }
      setNotice(`Imported ${response.documents.length} Markdown ${response.documents.length === 1 ? "note" : "notes"}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not import those Markdown files.");
    } finally {
      setImporting(false);
    }
  };

  const exportNotes = async () => {
    try {
      const response = await fetch("/api/export");
      if (!response.ok) throw new Error("The export could not be prepared.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `fieldnotes-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("Export downloaded.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not export notes.");
    }
  };

  const chooseFolder = (folderId: ActiveFolder) => {
    activeFolderRef.current = folderId;
    setActiveFolderId(folderId);
  };

  const selectFolderForRoute = useCallback((folderId: string) => {
    if (folderId === "unfiled") {
      setRouteError("");
      chooseFolder("root");
      return;
    }
    if (folders.length === 0) {
      chooseFolder(folderId);
      return;
    }
    if (!folders.some((folder) => folder.id === folderId)) {
      setRouteError("This folder could not be found.");
      chooseFolder(null);
      return;
    }
    setRouteError("");
    chooseFolder(folderId);
  }, [folders]);

  useEffect(() => {
    const route = currentRoute;
    const timer = window.setTimeout(() => {
      if (!workspaceRoutesEqual(currentRouteRef.current, route)) return;
      if (route.kind === "document") {
        void ensureDocumentForRoute(route.documentId);
        return;
      }
      if (route.kind === "folder") {
        selectFolderForRoute(route.folderId);
        return;
      }
      setRouteError("");
      if (route.kind === "library") {
        activeFolderRef.current = null;
        setActiveFolderId(null);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [currentRoute, ensureDocumentForRoute, selectFolderForRoute]);

  const beginFolderCreate = (parentId: string | null) => {
    setCreatingFolderParent(parentId);
    setNewFolderName("");
  };

  const createFolderFromForm = async (event: React.FormEvent<HTMLFormElement>): Promise<FolderRecord | null> => {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return null;
    try {
      const response = await apiRequest<FolderResponse>("/api/folders", jsonRequest("POST", {
        name,
        parentId: creatingFolderParent ?? null,
      }));
      setCreatingFolderParent(undefined);
      setNewFolderName("");
      setExpandedFolderIds((current) => {
        const next = new Set(current);
        if (creatingFolderParent) next.add(creatingFolderParent);
        next.add(response.folder.id);
        return next;
      });
      chooseFolder(response.folder.id);
      try {
        await Promise.all([refreshFolders(), refreshDocuments(), refreshRecent()]);
      } catch (error) {
        setNotice(error instanceof Error
          ? `Folder created, but the view could not refresh: ${error.message}`
          : "Folder created, but the view could not refresh.");
        return response.folder;
      }
      setNotice(`Created folder “${response.folder.name}”.`);
      return response.folder;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not create the folder.");
      return null;
    }
  };

  const renameFolder = async (folderId: string) => {
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (!folder) return;
    const name = await requestText({
      title: "Rename folder",
      description: "Choose a name for this folder.",
      label: "Folder name",
      initialValue: folder.name,
      submitLabel: "Save name",
      maxLength: 120,
    });
    if (name === null || name.trim() === folder.name) return;
    try {
      await apiRequest<FolderResponse>(`/api/folders/${folder.id}`, jsonRequest("PUT", {
        expectedVersion: folder.version,
        name,
      }));
      await Promise.all([refreshFolders(), refreshRecent()]);
      setNotice(`Renamed folder to “${name.trim()}”.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not rename the folder.");
    }
  };

  const renameActiveFolder = async () => {
    if (activeFolder) await renameFolder(activeFolder.id);
  };

  const moveActiveFolder = async (parentValue: string) => {
    if (!activeFolder) return;
    const parentId = parentValue === "root" ? null : parentValue;
    if (parentId === activeFolder.parentId) return;
    try {
      await apiRequest<FolderResponse>(`/api/folders/${activeFolder.id}`, jsonRequest("PUT", {
        expectedVersion: activeFolder.version,
        parentId,
      }));
      await Promise.all([refreshFolders(), refreshRecent()]);
      setNotice(`Moved folder “${activeFolder.name}”.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not move the folder.");
    }
  };

  const deleteActiveFolder = async (): Promise<boolean> => {
    if (!activeFolder) return false;
    if (!await requestConfirm({
      title: `Delete empty folder “${activeFolder.name}”?`,
      description: "Notes and subfolders are never deleted with a folder.",
      confirmLabel: "Delete folder",
      destructive: true,
    })) return false;
    try {
      await apiRequest<void>(`/api/folders/${activeFolder.id}`, jsonRequest("DELETE", { expectedVersion: activeFolder.version }));
      chooseFolder(null);
      await Promise.all([refreshFolders(), refreshDocuments(), refreshRecent()]);
      setNotice(`Deleted empty folder “${activeFolder.name}”.`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete the folder.");
      return false;
    }
  };

  const moveDocumentToFolder = async (folderId: string | null) => {
    const selected = selectedRef.current;
    if (!selected) return;
    if (isDirty) {
      setNotice("Save the current draft before moving this note.");
      return;
    }
    if (folderId === selected.folderId) return;
    setSaveState("saving");
    try {
      const response = await apiRequest<DocumentResponse>(
        `/api/documents/${selected.id}`,
        jsonRequest("PUT", {
          expectedVersion: selected.version,
          title: selected.title,
          body: selected.body,
          folderId,
        }),
      );
      acceptDocument(response.document, true, activeViewRef.current);
      await Promise.all([refreshDocuments(), refreshFolders(), refreshRecent()]);
      setNotice("Note moved.");
    } catch (error) {
      if (error instanceof ApiError && error.code === "version_conflict") {
        setSaveState("conflict");
        setExternalVersion(error.currentVersion ?? null);
        setNotice("This note changed elsewhere and was not moved. Load the latest version first.");
      } else {
        setSaveState("error");
        setNotice(error instanceof Error ? error.message : "Could not move the note.");
      }
    }
  };

  const selectedWordCount = useMemo(() => {
    return draftBody.trim() ? draftBody.trim().split(/\s+/).length : 0;
  }, [draftBody]);

  const linkedTitles = useMemo(() => {
    const ids = new Set(backlinks.map((document) => document.id));
    return documents.filter((document) => ids.has(document.id));
  }, [backlinks, documents]);

  const connectionLabel = connection === "connected" ? "Live sync on" : connection === "connecting" ? "Connecting" : "Reconnecting";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Keep the current theme for this tab if storage is unavailable.
    }
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
      "content",
      theme === "dark" ? "#171d19" : "#f7f7f5",
    );
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(DESKTOP_SIDEBAR_KEY, String(desktopSidebarCollapsed));
    } catch {
      // Keep the current sidebar state for this tab if storage is unavailable.
    }
  }, [desktopSidebarCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(DESKTOP_LIST_KEY, String(desktopListCollapsed));
    } catch {
      // Keep the current list state for this tab if storage is unavailable.
    }
  }, [desktopListCollapsed]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const updateAppViewport = () => {
      const visualHeight = viewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty(
        "--fieldnotes-app-visual-height",
        `${Math.min(window.innerHeight, visualHeight)}px`,
      );
      document.documentElement.style.setProperty(
        "--fieldnotes-app-visual-offset-top",
        `${viewport?.offsetTop ?? 0}px`,
      );
    };
    updateAppViewport();
    viewport?.addEventListener("resize", updateAppViewport);
    viewport?.addEventListener("scroll", updateAppViewport);
    window.addEventListener("resize", updateAppViewport);
    return () => {
      viewport?.removeEventListener("resize", updateAppViewport);
      viewport?.removeEventListener("scroll", updateAppViewport);
      window.removeEventListener("resize", updateAppViewport);
      document.documentElement.style.removeProperty("--fieldnotes-app-visual-height");
      document.documentElement.style.removeProperty("--fieldnotes-app-visual-offset-top");
    };
  }, []);

  useEffect(() => {
    if (mobileDrawerOpen || mobileDrawerSwipePreview) return;
    document.querySelectorAll<HTMLElement>(".mobile-navigation-drawer, .mobile-drawer-backdrop").forEach((element) => {
      element.style.removeProperty("transition");
      element.style.removeProperty("transform");
      element.style.removeProperty("opacity");
    });
  }, [mobileDrawerOpen, mobileDrawerSwipePreview]);

  useEffect(() => () => {
    if (drawerSwipeCloseTimerRef.current !== null) window.clearTimeout(drawerSwipeCloseTimerRef.current);
    if (drawerSwipeResetTimerRef.current !== null) window.clearTimeout(drawerSwipeResetTimerRef.current);
    if (suppressSwipeClickTimerRef.current !== null) window.clearTimeout(suppressSwipeClickTimerRef.current);
  }, []);

  const keepEditorControlVisible = useCallback((control: HTMLElement) => {
    window.requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      const visualTop = viewport?.offsetTop ?? 0;
      const visualBottom = visualTop + (viewport?.height ?? window.innerHeight);
      const bounds = control.getBoundingClientRect();
      if (bounds.top < visualTop + 8 || bounds.bottom > visualBottom - 64) {
        control.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 820px)");
    const syncRenderer = () => {
      const nextRenderer = workspaceRendererForViewport(window.innerWidth);
      if (nextRenderer === workspaceRendererRef.current) return;
      const editor = editorHostRef.current?.querySelector<HTMLElement>(".mle-prosemirror, .mle-source-textarea");
      editorWasFocusedBeforeResizeRef.current = Boolean(editor && (document.activeElement === editor || editor.contains(document.activeElement)));
      if (nextRenderer === "desktop" && drawerHistoryEntryRef.current) {
        pendingDrawerNavigationRef.current = null;
        window.history.back();
      }
      workspaceRendererRef.current = nextRenderer;
      setWorkspaceRenderer(nextRenderer);
    };
    mediaQuery.addEventListener("change", syncRenderer);
    window.addEventListener("resize", syncRenderer);
    syncRenderer();
    return () => {
      mediaQuery.removeEventListener("change", syncRenderer);
      window.removeEventListener("resize", syncRenderer);
    };
  }, []);

  useEffect(() => {
    if (!editorWasFocusedBeforeResizeRef.current) return;
    editorWasFocusedBeforeResizeRef.current = false;
    if (currentRoute.kind !== "document" || activeView !== "write") return;
    const frame = window.requestAnimationFrame(() => {
      const editor = editorHostRef.current?.querySelector<HTMLElement>(".mle-prosemirror, .mle-source-textarea");
      if (!editor) return;
      editor.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, currentRoute.kind, workspaceRenderer]);

  const switchEditorView = (nextView: "write" | "preview") => {
    if (nextView === activeViewRef.current) return;
    activeViewRef.current = nextView;
    setActiveView(nextView);
    if (nextView === "write") {
      window.requestAnimationFrame(() => {
        const editor = editorHostRef.current?.querySelector<HTMLElement>(".mle-prosemirror, .mle-source-textarea");
        if (!editor) return;
        editor.focus({ preventScroll: true });
      });
    }
  };

  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");

  const renderWorkspace = (screen: WorkspaceScreen, routeNavigation: WorkspaceNavigation) => {
    const activeScreen = screen.isActive !== false;
    const showDrawer = activeScreen && workspaceRenderer === "mobile-stackflow" && mobileDrawerOpen;
    const showDrawerPreview = activeScreen && workspaceRenderer === "mobile-stackflow" && mobileDrawerSwipePreview;
    const drawerPresented = showDrawer || showDrawerPreview;
    if (activeScreen) activeActivityIdRef.current = screen.activityId;
    const listFolderId = screen.kind === "folder"
      ? screen.folderId === "unfiled" ? "root" : screen.folderId
      : activeFolderId;
    const listViewKey = documentListViewKey(listFolderId, query, sortOrder);
    const displayDocument = screen.kind === "document" && selectedDocument?.id === screen.documentId
      ? selectedDocument
      : null;

    const confirmDraftLeave = async () => {
      const selected = selectedRef.current;
      if (!hasDraftChanged(selected, draftTitleRef.current, draftBodyRef.current)) return true;
      const approved = await requestConfirm({
        title: "Discard this draft?",
        description: "The unsaved changes in this note will be discarded if you continue.",
        confirmLabel: "Discard draft",
        destructive: true,
      });
      if (approved && selected) draftsRef.current.delete(selected.id);
      return approved;
    };

    const revealDocumentList = () => setDesktopListCollapsed(false);

    const navigateToLibrary = async () => {
      if (screen.kind === "library") {
        closeMobileDrawer();
        revealDocumentList();
        setQuery("");
        chooseFolder(null);
        setVisibleDocuments(documents);
        return;
      }
      if (!await confirmDraftLeave()) return;
      revealDocumentList();
      setQuery("");
      chooseFolder(null);
      routeNavigation.push("Library", {});
    };

    const navigateToRecent = async () => {
      if (screen.kind === "recent") {
        closeMobileDrawer();
        return;
      }
      if (!await confirmDraftLeave()) return;
      routeNavigation.push("Recent", {});
    };

    const navigateToFolder = async (folderId: ActiveFolder) => {
      if (folderId === null) {
        await navigateToLibrary();
        return;
      }
      const routeId = folderId === "root" ? "unfiled" : folderId;
      if (screen.kind === "folder" && screen.folderId === routeId) {
        closeMobileDrawer();
        revealDocumentList();
        chooseFolder(folderId);
        return;
      }
      if (!await confirmDraftLeave()) return;
      revealDocumentList();
      chooseFolder(folderId);
      setRouteError("");
      routeNavigation.push("Folder", { folderId: routeId });
    };

    const resetListFilters = () => {
      setQuery("");
      setSortOrder("updated-desc");
      setVisibleDocuments(documents);
      if (activeFolderRef.current !== null) {
        chooseFolder(null);
        setRouteError("");
        if (screen.kind === "folder") routeNavigation.push("Library", {});
      }
    };

    const navigateToDocument = async (id: string) => {
      if (navigationPendingRef.current) return;
      if (screen.kind === "document" && screen.documentId === id) return;
      navigationPendingRef.current = true;
      try {
        if (!await openDocument(id)) return;
        routeNavigation.push("Document", { documentId: id });
      } finally {
        navigationPendingRef.current = false;
      }
    };

    const createAndOpenNote = async () => {
      const created = await createNote();
      if (created) routeNavigation.push("Document", { documentId: created.id });
    };

    const navigateBack = () => {
      if (routeNavigation.canGoBack) routeNavigation.pop();
      else routeNavigation.replace("Library", {});
    };

    const backFromDocument = () => {
      if (hasDraftChanged(selectedRef.current, draftTitleRef.current, draftBodyRef.current)) {
        setNotice("Your draft is kept in this tab. Reopen this note to continue editing.");
      }
      navigateBack();
    };

    const deleteAndReturn = async () => {
      if (await deleteCurrentDocument()) navigateBack();
    };

    const deleteFolderAndReturn = async () => {
      if (!await confirmDraftLeave()) return;
      if (await deleteActiveFolder()) routeNavigation.replace("Library", {});
    };

    const createFolderAndOpen = async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!await confirmDraftLeave()) return;
      const folder = await createFolderFromForm(event);
      if (folder) routeNavigation.push("Folder", { folderId: folder.id });
    };

    const openChange = (change: ChangeRecord) => {
      if (change.entityType === "folder") {
        if (change.operation === "deleted" || !change.folderId) {
          setNotice(`Folder “${change.title}” was deleted.`);
        } else {
          void navigateToFolder(change.folderId);
        }
        return;
      }
      if (change.operation === "deleted") {
        setNotice(`“${change.title}” was deleted.`);
        return;
      }
      if (change.documentId) void navigateToDocument(change.documentId);
    };

    const renderFolderBrowser = (surface: "list" | "drawer") => {
      const folderInputId = "new-folder-name-" + screen.activityId + "-" + surface;
      return (
        <nav
          className={"folder-browser " + (surface === "drawer" ? "drawer-folder-browser" : "list-folder-browser")}
          aria-label="Folder navigation"
        >
          <div className="folder-browser-header">
            <span>FOLDERS</span>
            <button type="button" className="folder-create-trigger" onClick={() => beginFolderCreate(null)}>
              <FolderPlus size={13} /> New folder
            </button>
          </div>
          <button
            type="button"
            className={"folder-nav-item" + (activeFolderId === null ? " active" : "")}
            onClick={() => void navigateToFolder(null)}
            aria-current={activeFolderId === null ? "page" : undefined}
          >
            <FileText size={14} /><span>All notes</span><span className="folder-count">{documentListStatus === "loaded" ? documents.length : <span className="count-skeleton" role="status" aria-label="Loading note count" />}</span>
          </button>
          <button
            type="button"
            className={"folder-nav-item" + (activeFolderId === "root" ? " active" : "")}
            onClick={() => void navigateToFolder("root")}
            aria-current={activeFolderId === "root" ? "page" : undefined}
          >
            <Folder size={14} /><span>Unfiled</span><span className="folder-count">{documents.filter((document) => document.folderId === null).length}</span>
          </button>
          <div className="folder-tree-list">
            {visibleFolderRows.map(({ folder, depth, hasChildren }) => (
              <div className="folder-tree-row" key={folder.id}>
                <span className="folder-depth-space" style={{ width: (depth * 13) + "px" }} aria-hidden="true" />
                {hasChildren ? (
                  <button
                    type="button"
                    className="folder-disclosure"
                    aria-label={(expandedFolderIds.has(folder.id) ? "Collapse " : "Expand ") + folder.name}
                    aria-expanded={expandedFolderIds.has(folder.id)}
                    onClick={() => setExpandedFolderIds((current) => {
                      const next = new Set(current);
                      if (next.has(folder.id)) next.delete(folder.id);
                      else next.add(folder.id);
                      return next;
                    })}
                  >
                    {expandedFolderIds.has(folder.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                ) : <span className="folder-disclosure-spacer" aria-hidden="true" />}
                <button
                  type="button"
                  className={"folder-nav-item folder-tree-button" + (activeFolderId === folder.id ? " active" : "")}
                  onClick={() => void navigateToFolder(folder.id)}
                  aria-current={activeFolderId === folder.id ? "page" : undefined}
                  title={folderPathById.get(folder.id)}
                >
                  {activeFolderId === folder.id ? <FolderOpen size={14} /> : <Folder size={14} />}
                  <span>{folder.name}</span><span className="folder-count">{folder.documentCount}</span>
                </button>
                <button
                  type="button"
                  className="folder-row-action"
                  aria-label={"Rename " + folder.name}
                  title={"Rename " + folder.name}
                  onClick={() => void renameFolder(folder.id)}
                ><Pencil size={13} /></button>
              </div>
            ))}
          </div>
          {creatingFolderParent !== undefined && (
            <form className="folder-create-form" onSubmit={(event) => void createFolderAndOpen(event)}>
              <label htmlFor={folderInputId}>
                New {creatingFolderParent ? "subfolder in " + (folderPathById.get(creatingFolderParent) ?? "folder") : "top-level folder"}
              </label>
              <input
                id={folderInputId}
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.currentTarget.value)}
                maxLength={120}
                autoFocus={surface === "drawer" ? showDrawer : true}
                required
              />
              <div>
                <button type="submit">Create</button>
                <button type="button" onClick={() => setCreatingFolderParent(undefined)}>Cancel</button>
              </div>
            </form>
          )}
          {activeFolder && (
            <div className="folder-admin" aria-label={activeFolder.name + " folder actions"}>
              <div className="folder-admin-actions">
                <button type="button" onClick={() => beginFolderCreate(activeFolder.id)}><FolderPlus size={13} /> Subfolder</button>
                <button type="button" onClick={() => void renameActiveFolder()}>Rename</button>
                <button type="button" onClick={() => void deleteFolderAndReturn()}>Delete empty</button>
              </div>
              <label className="folder-move-label">
                Move folder
                <select
                  value={activeFolder.parentId ?? "root"}
                  onChange={(event) => void moveActiveFolder(event.currentTarget.value)}
                  aria-label={"Move " + activeFolder.name + " to parent folder"}
                >
                  <option value="root">Top level</option>
                  {folders.filter((folder) => !excludedFolderParents.has(folder.id)).map((folder) => (
                    <option key={folder.id} value={folder.id}>{folderPathById.get(folder.id) ?? folder.name}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </nav>
      );
    };

    const renderListTools = (surface: "desktop" | "drawer") => (
      <>
        <button
          type="button"
          className={"text-tool" + (surface === "drawer" ? " drawer-tool" : "")}
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
        >
          {importing ? <LoaderCircle className="spin" size={14} /> : <ArrowUpFromLine size={14} />}
          <span className={surface === "drawer" ? "drawer-tool-label" : undefined}>
            {surface === "drawer" ? "Import Markdown" : "Import"}
          </span>
        </button>
        <button
          type="button"
          className={"text-tool" + (surface === "drawer" ? " drawer-tool" : "")}
          onClick={() => void exportNotes()}
          title="Download a JSON export"
        >
          <ArrowDownToLine size={14} />
          <span className={surface === "drawer" ? "drawer-tool-label" : undefined}>
            {surface === "drawer" ? "Export backup" : "Export"}
          </span>
        </button>
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept=".md,.markdown,text/markdown"
          multiple
          tabIndex={-1}
          onChange={(event) => void importMarkdown(event)}
          aria-label="Select Markdown files to import"
        />
      </>
    );

    const handleMobileTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
      clearDrawerSwipeTimers();
      if (suppressSwipeClickTimerRef.current !== null) {
        window.clearTimeout(suppressSwipeClickTimerRef.current);
        suppressSwipeClickTimerRef.current = null;
      }
      suppressSwipeClickRef.current = false;
      mobileDrawerTouchStartRef.current = null;

      if (workspaceRenderer !== "mobile-stackflow" || !activeScreen || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;
      const drawer = event.currentTarget.querySelector<HTMLElement>(".mobile-navigation-drawer");
      const startedInDrawer = drawer?.contains(event.target as Node) ?? false;
      if (showDrawer && !startedInDrawer) return;
      if (!showDrawer && screen.kind !== "library" && screen.kind !== "folder") return;
      if (showDrawer && drawer) {
        drawer.style.transition = "none";
        drawer.style.transform = "translateX(0)";
        const backdrop = event.currentTarget.querySelector<HTMLElement>(".mobile-drawer-backdrop");
        if (backdrop) {
          backdrop.style.transition = "none";
          backdrop.style.opacity = "1";
        }
      }

      mobileDrawerTouchStartRef.current = {
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        drawerWasOpen: showDrawer,
        startedInDrawer,
        listRoute: screen.kind === "library" || screen.kind === "folder",
        viewportWidth: window.innerWidth,
        axis: "pending",
        direction: null,
        previewActive: false,
      };
    };

    const markSwipeClick = () => {
      suppressSwipeClickRef.current = true;
      if (suppressSwipeClickTimerRef.current !== null) window.clearTimeout(suppressSwipeClickTimerRef.current);
      suppressSwipeClickTimerRef.current = window.setTimeout(() => {
        suppressSwipeClickRef.current = false;
        suppressSwipeClickTimerRef.current = null;
      }, 500);
    };

    const clearDrawerSwipeTimers = () => {
      if (drawerSwipeCloseTimerRef.current !== null) {
        window.clearTimeout(drawerSwipeCloseTimerRef.current);
        drawerSwipeCloseTimerRef.current = null;
      }
      if (drawerSwipeResetTimerRef.current !== null) {
        window.clearTimeout(drawerSwipeResetTimerRef.current);
        drawerSwipeResetTimerRef.current = null;
      }
    };

    const finishSwipePreview = (workspace: HTMLElement, wasOpen: boolean) => {
      const drawer = workspace.querySelector<HTMLElement>(".mobile-navigation-drawer");
      const backdrop = workspace.querySelector<HTMLElement>(".mobile-drawer-backdrop");
      if (!drawer) {
        setMobileDrawerSwipePreview(false);
        return;
      }
      drawer.style.transition = "transform 160ms ease-out";
      drawer.style.transform = wasOpen ? "translateX(0)" : `translateX(-${window.innerWidth}px)`;
      if (backdrop) {
        backdrop.style.transition = "opacity 160ms ease-out";
        backdrop.style.opacity = wasOpen ? "1" : "0";
      }
      clearDrawerSwipeTimers();
      drawerSwipeResetTimerRef.current = window.setTimeout(() => {
        drawerSwipeResetTimerRef.current = null;
        setMobileDrawerSwipePreview(false);
      }, 170);
    };

    const handleMobileTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
      const started = mobileDrawerTouchStartRef.current;
      if (!started || started.axis === "vertical" || started.axis === "cancelled") return;
      const touch = Array.from(event.touches).find((item) => item.identifier === started.identifier);
      if (!touch) return;
      const drag = resolveMobileDrawerSwipeDrag({
        ...started,
        currentX: touch.clientX,
        currentY: touch.clientY,
      });
      if (!drag) {
        const deltaX = touch.clientX - started.startX;
        const deltaY = touch.clientY - started.startY;
        if (Math.abs(deltaY) >= 10 && Math.abs(deltaY) > Math.abs(deltaX) * 1.2) {
          started.axis = "vertical";
          if (started.previewActive) finishSwipePreview(event.currentTarget, false);
        } else if (started.axis === "horizontal") {
          started.axis = "cancelled";
          if (started.previewActive) finishSwipePreview(event.currentTarget, started.drawerWasOpen);
        }
        return;
      }
      if (started.axis === "horizontal" && started.direction !== drag.direction) {
        started.axis = "cancelled";
        if (started.previewActive) finishSwipePreview(event.currentTarget, started.drawerWasOpen);
        return;
      }
      started.axis = "horizontal";
      started.direction = drag.direction;

      const drawer = event.currentTarget.querySelector<HTMLElement>(".mobile-navigation-drawer");
      if (!drawer) return;
      if (!started.drawerWasOpen && !started.previewActive) {
        clearDrawerSwipeTimers();
        drawer.hidden = false;
        drawer.style.transition = "none";
        drawer.style.transform = `translateX(-${started.viewportWidth}px)`;
        started.previewActive = true;
        setMobileDrawerSwipePreview(true);
      }

      const width = drawer.getBoundingClientRect().width || started.viewportWidth;
      const offset = drag.direction === "open"
        ? Math.max(-width, Math.min(0, -width + touch.clientX - started.startX))
        : Math.max(-width, Math.min(0, touch.clientX - started.startX));
      drawer.style.transition = "none";
      drawer.style.transform = `translateX(${offset}px)`;
      const backdrop = event.currentTarget.querySelector<HTMLElement>(".mobile-drawer-backdrop");
      if (backdrop) {
        const progress = 1 + offset / width;
        backdrop.style.transition = "none";
        backdrop.style.opacity = String(Math.max(0, Math.min(1, progress)));
      }
    };

    const handleMobileTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
      const started = mobileDrawerTouchStartRef.current;
      mobileDrawerTouchStartRef.current = null;
      if (!started) return;

      const touch = Array.from(event.changedTouches).find((item) => item.identifier === started.identifier);
      if (!touch) return;
      const direction = resolveMobileDrawerSwipe({
        ...started,
        endX: touch.clientX,
        endY: touch.clientY,
      });
      if (!direction || direction !== started.direction || started.axis !== "horizontal") {
        if (started.direction !== null || started.axis === "horizontal" || started.axis === "cancelled") markSwipeClick();
        if (started.previewActive || started.drawerWasOpen) finishSwipePreview(event.currentTarget, started.drawerWasOpen);
        return;
      }

      markSwipeClick();
      clearDrawerSwipeTimers();
      const drawer = event.currentTarget.querySelector<HTMLElement>(".mobile-navigation-drawer");
      const backdrop = event.currentTarget.querySelector<HTMLElement>(".mobile-drawer-backdrop");
      if (drawer) {
        const width = drawer.getBoundingClientRect().width || started.viewportWidth;
        drawer.style.transition = "transform 180ms ease-out";
        drawer.style.transform = direction === "open" ? "translateX(0)" : `translateX(-${width}px)`;
      }
      if (backdrop) {
        backdrop.style.transition = "opacity 180ms ease-out";
        backdrop.style.opacity = direction === "open" ? "1" : "0";
      }
      if (direction === "open") {
        openMobileDrawer(event.currentTarget.querySelector<HTMLElement>(".mobile-menu-button"));
        setMobileDrawerSwipePreview(false);
      } else {
        drawerSwipeCloseTimerRef.current = window.setTimeout(() => {
          drawerSwipeCloseTimerRef.current = null;
          closeMobileDrawer();
        }, 185);
      }
    };

    const handleMobileTouchCancel = (event: React.TouchEvent<HTMLDivElement>) => {
      const started = mobileDrawerTouchStartRef.current;
      mobileDrawerTouchStartRef.current = null;
      if (started && (started.previewActive || started.drawerWasOpen)) {
        finishSwipePreview(event.currentTarget, started.drawerWasOpen);
      }
    };

    const handleSwipeClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
      if (!suppressSwipeClickRef.current || event.detail === 0) return;
      suppressSwipeClickRef.current = false;
      if (suppressSwipeClickTimerRef.current !== null) {
        window.clearTimeout(suppressSwipeClickTimerRef.current);
        suppressSwipeClickTimerRef.current = null;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    if (screen.kind === "not-found") {
      return (
        <main id={`fieldnotes-activity-${screen.activityId}`} data-fieldnotes-route="not-found" className="route-not-found">
          <div className="welcome-art" aria-hidden="true"><span className="art-paper paper-back" /><span className="art-paper paper-front"><span /><span /><span /></span></div>
          <h1 className="workspace-title">That page isn’t here.</h1>
          <p>Open your note library to keep working.</p>
          <button type="button" className="welcome-create" onClick={() => routeNavigation.replace("Library", {})}>Back to notes</button>
        </main>
      );
    }

    return (
    <div
      id={`fieldnotes-activity-${screen.activityId}`}
      data-fieldnotes-route={screen.kind}
      className={`app-shell route-${screen.kind}${displayDocument ? " has-selection" : ""}${workspaceRenderer === "desktop" && desktopSidebarCollapsed ? " sidebar-collapsed" : ""}${workspaceRenderer === "desktop" && desktopListCollapsed ? " list-collapsed" : ""}`}
      onTouchStart={handleMobileTouchStart}
      onTouchMove={handleMobileTouchMove}
      onTouchEnd={handleMobileTouchEnd}
      onTouchCancel={handleMobileTouchCancel}
      onClickCapture={handleSwipeClickCapture}
    >
      <header className="mobile-topbar" aria-hidden={showDrawer}>
        <button
          type="button"
          className="mobile-menu-button"
          aria-label="Open navigation"
          aria-expanded={showDrawer}
          aria-controls={"fieldnotes-mobile-drawer-" + screen.activityId}
          onClick={(event) => openMobileDrawer(event.currentTarget)}
        ><Menu size={19} aria-hidden="true" /></button>
        <div className="mobile-topbar-brand">
          <span className="brand-mark"><BookOpen size={17} strokeWidth={2.1} /></span>
          <span>Fieldnotes</span>
        </div>
        <div className="mobile-topbar-sync" aria-label={connectionLabel} aria-live="polite">
          <span className={"connection-dot " + connection} aria-hidden="true" />
          <span>{connection === "connected" ? "Live" : connection === "connecting" ? "Syncing" : "Reconnecting"}</span>
        </div>
      </header>
      {drawerPresented && (
        <button
          type="button"
          className="mobile-drawer-backdrop"
          aria-label="Close navigation"
          aria-hidden="true"
          tabIndex={-1}
          onClick={closeMobileDrawer}
        />
      )}
      <aside
        id={"fieldnotes-mobile-drawer-" + screen.activityId}
        className="left-rail mobile-navigation-drawer"
        aria-label={showDrawer ? "Navigation and folders" : "Workspace"}
        aria-hidden={workspaceRenderer === "mobile-stackflow" && !showDrawer}
        aria-modal={showDrawer ? true : undefined}
        role={showDrawer ? "dialog" : undefined}
        inert={workspaceRenderer === "mobile-stackflow" && !showDrawer}
        tabIndex={-1}
        hidden={workspaceRenderer === "mobile-stackflow" && !drawerPresented}
      >
        <button type="button" className="mobile-drawer-close" onClick={closeMobileDrawer}>
          <X size={18} aria-hidden="true" /><span>Close navigation</span>
        </button>
        <div className="brand-lockup">
          <div className="brand-identity">
            <div className="brand-mark"><BookOpen size={18} strokeWidth={2.1} /></div>
            <div className="brand-copy">
              <div className="brand-name">Fieldnotes</div>
              <div className="brand-caption">PERSONAL LIBRARY</div>
            </div>
          </div>
          {workspaceRenderer === "desktop" && (
            <button
              type="button"
              className="desktop-sidebar-toggle"
              aria-label={desktopSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!desktopSidebarCollapsed}
              title={desktopSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setDesktopSidebarCollapsed((collapsed) => !collapsed)}
            >
              {desktopSidebarCollapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
            </button>
          )}
        </div>

        <div className="rail-section-label">YOUR SPACE</div>
        <button className={`rail-link${screen.kind === "library" ? " active" : ""}`} type="button" title="All notes" aria-label="All notes" onClick={() => void navigateToLibrary()}>
          <FileText size={16} />
          <span>All notes</span>
          <span className="rail-count">{documentListStatus === "loaded" ? documents.length : <span className="count-skeleton" role="status" aria-label="Loading note count" />}</span>
        </button>
        <button className={`rail-link${screen.kind === "recent" ? " active" : ""}`} type="button" title="Recent changes" aria-label="Recent changes" onClick={() => void navigateToRecent()}><Clock3 size={16} /><span>Recent changes</span></button>
        {workspaceRenderer === "desktop" && desktopListCollapsed && (
          <button
            className="rail-link desktop-list-reopen"
            type="button"
            title="Show notes list"
            aria-label="Show notes list"
            aria-expanded={false}
            aria-controls="fieldnotes-note-list"
            onClick={() => setDesktopListCollapsed(false)}
          ><PanelLeftOpen size={16} aria-hidden="true" /><span>Show notes list</span></button>
        )}

        {workspaceRenderer === "mobile-stackflow" && renderFolderBrowser("drawer")}

        <div className="recent-heading">
          <span className="rail-section-label">RECENT ACTIVITY</span>
          <span className="live-dot" aria-hidden="true" />
        </div>
        <div className="activity-list">
          {recentChanges.slice(-7).reverse().map((change) => (
            <button
              className="activity-item"
              key={change.seq}
              type="button"
              onClick={() => openChange(change)}
              disabled={change.operation === "deleted"}
              title={`${operationLabel(change.operation)} ${change.entityType} ${change.title}`}
            >
              <span className={`activity-indicator ${change.operation}`} aria-hidden="true" />
              <span className="activity-copy">
                <span className="activity-title">{change.title}</span>
                <span className="activity-meta">{operationLabel(change.operation)} {change.entityType} · {relativeDate(change.createdAt)}</span>
              </span>
            </button>
          ))}
          {recentChanges.length === 0 && <p className="activity-empty">New edits will appear here.</p>}
        </div>

        {workspaceRenderer === "mobile-stackflow" && (
          <section className="mobile-drawer-secondary" aria-label="More options">
            <div className="rail-section-label">MORE</div>
            <button
              type="button"
              className="drawer-action"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light appearance" : "Switch to dark appearance"}
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
              <span>{theme === "dark" ? "Light appearance" : "Dark appearance"}</span>
            </button>
            <div className="mobile-drawer-data-actions">{renderListTools("drawer")}</div>
          </section>
        )}

        <div className="rail-bottom">
          <div className="local-badge"><span className={`connection-dot ${connection}`} />{connectionLabel}</div>
          <p>Stored on this Mac<br />and ready for your agents.</p>
        </div>
      </aside>

      <section className="note-column" id="fieldnotes-note-list" aria-label="Notes">
        <div className="list-header">
          <div>
            <div className="eyebrow">YOUR LIBRARY</div>
          <div className="list-title-row"><h1 ref={notesHeadingRef} tabIndex={-1}>{activeFolderId === "root" ? "Unfiled" : activeFolder?.name ?? "Notes"}</h1><span className="total-count">{documentListStatus === "loaded" ? activeFolderId === null ? documents.length : visibleDocuments.length : <span className="count-skeleton" role="status" aria-label="Loading note count" />}</span></div>
          </div>
          <div className="mobile-list-actions">
            <button className="icon-button theme-toggle theme-toggle-list" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button className="mobile-recent-button" type="button" onClick={() => void navigateToRecent()} aria-label="Recent changes" title="Recent changes"><Clock3 size={18} /></button>
            <button className="icon-button add-note-button" type="button" onClick={() => void createAndOpenNote()} aria-label="Create a note" title="Create a note">
              <Plus size={18} />
            </button>
          </div>
          {workspaceRenderer === "desktop" && (
            <div className="desktop-list-actions">
              <button
                className="icon-button desktop-list-toggle"
                type="button"
                aria-label="Collapse note list"
                aria-expanded={true}
                aria-controls="fieldnotes-note-list"
                title="Collapse note list"
                onClick={() => setDesktopListCollapsed(true)}
              ><PanelLeftClose size={17} aria-hidden="true" /></button>
            </div>
          )}
        </div>

        <label className="search-box">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search your notes"
            aria-label="Search all notes"
          />
          {query && <button type="button" className="clear-search" aria-label="Clear search" onClick={() => setQuery("")}><X size={14} /></button>}
          {!query && <kbd>⌘ K</kbd>}
        </label>

        {workspaceRenderer === "desktop" && (
        <nav className="folder-browser list-folder-browser" aria-label="Folder navigation">
          <div className="folder-browser-header">
            <span>FOLDERS</span>
            <button type="button" className="folder-create-trigger" onClick={() => beginFolderCreate(null)}>
              <FolderPlus size={13} /> New folder
            </button>
          </div>
          <button
            type="button"
            className={`folder-nav-item${activeFolderId === null ? " active" : ""}`}
            onClick={() => void navigateToFolder(null)}
            aria-current={activeFolderId === null ? "page" : undefined}
          >
            <FileText size={14} /><span>All notes</span><span className="folder-count">{documentListStatus === "loaded" ? documents.length : <span className="count-skeleton" role="status" aria-label="Loading note count" />}</span>
          </button>
          <button
            type="button"
            className={`folder-nav-item${activeFolderId === "root" ? " active" : ""}`}
            onClick={() => void navigateToFolder("root")}
            aria-current={activeFolderId === "root" ? "page" : undefined}
          >
            <Folder size={14} /><span>Unfiled</span><span className="folder-count">{documents.filter((document) => document.folderId === null).length}</span>
          </button>
          <div className="folder-tree-list">
            {visibleFolderRows.map(({ folder, depth, hasChildren }) => (
              <div className="folder-tree-row" key={folder.id}>
                <span className="folder-depth-space" style={{ width: `${depth * 13}px` }} aria-hidden="true" />
                {hasChildren ? (
                  <button
                    type="button"
                    className="folder-disclosure"
                    aria-label={`${expandedFolderIds.has(folder.id) ? "Collapse" : "Expand"} ${folder.name}`}
                    aria-expanded={expandedFolderIds.has(folder.id)}
                    onClick={() => setExpandedFolderIds((current) => {
                      const next = new Set(current);
                      if (next.has(folder.id)) next.delete(folder.id);
                      else next.add(folder.id);
                      return next;
                    })}
                  >
                    {expandedFolderIds.has(folder.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                ) : <span className="folder-disclosure-spacer" aria-hidden="true" />}
                <button
                  type="button"
                  className={`folder-nav-item folder-tree-button${activeFolderId === folder.id ? " active" : ""}`}
                  onClick={() => void navigateToFolder(folder.id)}
                  aria-current={activeFolderId === folder.id ? "page" : undefined}
                  title={folderPathById.get(folder.id)}
                >
                  {activeFolderId === folder.id ? <FolderOpen size={14} /> : <Folder size={14} />}
                  <span>{folder.name}</span><span className="folder-count">{folder.documentCount}</span>
                </button>
                <button
                  type="button"
                  className="folder-row-action"
                  aria-label={`Rename ${folder.name}`}
                  title={`Rename ${folder.name}`}
                  onClick={() => void renameFolder(folder.id)}
                ><Pencil size={13} /></button>
              </div>
            ))}
          </div>
          {creatingFolderParent !== undefined && (
            <form className="folder-create-form" onSubmit={(event) => void createFolderAndOpen(event)}>
              <label htmlFor="new-folder-name">New {creatingFolderParent ? `subfolder in ${folderPathById.get(creatingFolderParent) ?? "folder"}` : "top-level folder"}</label>
              <input
                id="new-folder-name"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.currentTarget.value)}
                maxLength={120}
                autoFocus
                required
              />
              <div>
                <button type="submit">Create</button>
                <button type="button" onClick={() => setCreatingFolderParent(undefined)}>Cancel</button>
              </div>
            </form>
          )}
          {activeFolder && (
            <div className="folder-admin" aria-label={`${activeFolder.name} folder actions`}>
              <div className="folder-admin-actions">
                <button type="button" onClick={() => beginFolderCreate(activeFolder.id)}><FolderPlus size={13} /> Subfolder</button>
                <button type="button" onClick={() => void renameActiveFolder()}>Rename</button>
                <button type="button" onClick={() => void deleteFolderAndReturn()}>Delete empty</button>
              </div>
              <label className="folder-move-label">
                Move folder
                <select
                  value={activeFolder.parentId ?? "root"}
                  onChange={(event) => void moveActiveFolder(event.currentTarget.value)}
                  aria-label={`Move ${activeFolder.name} to parent folder`}
                >
                  <option value="root">Top level</option>
                  {folders.filter((folder) => !excludedFolderParents.has(folder.id)).map((folder) => (
                    <option key={folder.id} value={folder.id}>{folderPathById.get(folder.id) ?? folder.name}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </nav>
        )}

        <div className="list-subhead">
          <span>{documentListStatus === "loading" ? "LOADING NOTES" : query ? `${visibleDocuments.length} RESULTS` : activeFolderId === "root" ? "UNFILED NOTES" : activeFolder ? folderPathById.get(activeFolder.id)?.toUpperCase() : "ALL NOTES"}</span>
          {workspaceRenderer === "desktop" && <div className="list-tools">{renderListTools("desktop")}</div>}
        </div>

        <div className="list-filter-row">
          <label className="sort-control">
            <ArrowDownUp size={14} aria-hidden="true" />
            <select aria-label="Sort notes" value={sortOrder} onChange={(event) => setSortOrder(event.currentTarget.value as SortOrder)}>
              <option value="updated-desc">Updated · newest</option>
              <option value="updated-asc">Updated · oldest</option>
              <option value="title-asc">Title · A to Z</option>
              <option value="title-desc">Title · Z to A</option>
            </select>
          </label>
          <span className="visually-hidden" aria-live="polite">{documentListStatus === "loading" ? "Loading notes" : `${visibleDocuments.length} search results`}</span>
          {(query.trim() || activeFolderId !== null || sortOrder !== "updated-desc") && (
            <button type="button" className="reset-filters" onClick={resetListFilters}>Reset</button>
          )}
        </div>

        {listError && <div className="list-error"><span>{listError}</span><button type="button" onClick={() => void refreshDocuments().catch(() => setListError("The local service is unavailable. Reconnecting…"))}><RefreshCw size={14} /> Retry</button></div>}

        <div
          className="document-list"
          role="list"
          aria-busy={documentListStatus === "loading"}
          data-list-view-key={listViewKey}
          onScroll={(event) => storeDocumentListScroll(event.currentTarget)}
        >
          {documentListStatus === "loading" ? <DocumentListSkeleton /> : orderedDocuments.map((document) => (
            <button
              className={`document-row${screen.kind === "document" && screen.documentId === document.id ? " selected" : ""}`}
              type="button"
              key={document.id}
              role="listitem"
              data-document-id={document.id}
              onClick={() => void navigateToDocument(document.id)}
            >
              <div className="document-row-top">
                <span className="document-row-title"><SearchHighlight text={document.title} query={query} /></span>
                <time dateTime={document.updatedAt}>{formatDocumentDate(document.updatedAt)}</time>
              </div>
              <span className="document-excerpt"><SearchHighlight text={document.excerpt || "A new note, ready for a first thought."} query={query} /></span>
            </button>
          ))}
          {documentListStatus === "loaded" && visibleDocuments.length === 0 && !listError && (
            <div className="empty-list">
              <div className="empty-list-icon"><Search size={17} /></div>
              <strong>{query ? "No matching notes" : "Nothing here yet"}</strong>
              <span>{query ? "Try a different title or phrase." : "Create a note to get started."}</span>
              {!query && <button type="button" onClick={() => void createAndOpenNote()}><Plus size={15} /> New note</button>}
            </div>
          )}
        </div>
        <div className="list-footer"><span>{documentListStatus === "loading" ? "Loading notes…" : documentListStatus === "error" ? "Notes unavailable" : `${visibleDocuments.length} ${visibleDocuments.length === 1 ? "note" : "notes"}`}</span><span>⌘ S to save</span></div>
      </section>

      <main className={`editor-pane${screen.kind === "recent" ? " recent-editor-pane" : ""}`} tabIndex={-1}>
        {screen.kind === "recent" ? (
          <div className="recent-workspace">
            <header className="recent-page-header">
              <button type="button" className="recent-back" onClick={navigateBack} aria-label="Go back"><ChevronLeft size={20} /></button>
              <div>
                <div className="eyebrow">YOUR SPACE</div>
                <h1 className="workspace-title" tabIndex={-1}>Recent changes</h1>
              </div>
              <button type="button" className="recent-library" onClick={() => void navigateToLibrary()}><FileText size={15} /> All notes</button>
            </header>
            <div className="recent-page-content">
              {routeError && <div className="list-error" role="status">{routeError}</div>}
              <p className="recent-intro">Saved updates from this library, including changes made by agents.</p>
              {recentChanges.length ? (
                <ol className="recent-timeline">
                  {recentChanges.map((change) => (
                    <li key={change.seq}>
                      <span className={`activity-indicator ${change.operation}`} aria-hidden="true" />
                      <button
                        type="button"
                        className="recent-change"
                        onClick={() => openChange(change)}
                        disabled={change.operation === "deleted"}
                      >
                        <span className="recent-change-title">{change.title}</span>
                        <span className="recent-change-meta">{operationLabel(change.operation)} {change.entityType} · {relativeDate(change.createdAt)}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : <p className="activity-empty">No saved changes yet.</p>}
            </div>
          </div>
        ) : <>
        {routeError && <div className="route-error" role="status">{routeError}</div>}
        {displayDocument ? (
          <>
            <header className="editor-toolbar">
              <div className="editor-breadcrumb">
                <button className="mobile-back" type="button" onClick={backFromDocument} aria-label="Back to notes"><ChevronLeft size={18} /></button>
                <span className="breadcrumb-muted">{displayDocument.folderId ? folderPathById.get(displayDocument.folderId) ?? "Folder" : "Unfiled"}</span><span className="breadcrumb-divider">/</span>
                <span className="breadcrumb-title">{draftTitle || "Untitled note"}</span>
              </div>
              <div className="toolbar-actions">
                <div className={`save-indicator ${saveState}`}>
                  {saveState === "saving" ? <LoaderCircle className="spin" size={14} /> : saveState === "saved" ? <Check size={14} /> : saveState === "conflict" ? <RefreshCw size={13} /> : <span className="unsaved-dot" />}
                  <span>{saveStateLabel(saveState)}</span>
                </div>
                <div className="view-switch" role="group" aria-label="Editor view">
                  <button type="button" className={activeView === "write" ? "chosen" : ""} onClick={() => switchEditorView("write")} aria-label="Write" title="Write" aria-pressed={activeView === "write"}><Pencil size={15} aria-hidden="true" /><span className="toolbar-action-label">Write</span></button>
                  <button type="button" className={activeView === "preview" ? "chosen" : ""} onClick={() => switchEditorView("preview")} aria-label="Preview" title="Preview" aria-pressed={activeView === "preview"}><Eye size={15} aria-hidden="true" /><span className="toolbar-action-label">Preview</span></button>
                </div>
                <button type="button" className="save-button" onClick={() => void saveDocument()} disabled={!isDirty || saveState === "saving"} aria-label="Save changes" title="Save changes">
                  <Save size={15} aria-hidden="true" /><span className="toolbar-action-label">Save</span>
                </button>
                <button className="icon-button toolbar-delete" type="button" onClick={() => void deleteAndReturn()} aria-label="Delete note" title="Delete note"><Trash2 size={16} /></button>
                <button className="icon-button theme-toggle theme-toggle-editor" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
                  {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
                </button>
              </div>
            </header>

            {notice && <div className={`notice-bar${saveState === "error" || saveState === "conflict" ? " warning" : ""}`} role="status"><span>{notice}</span><button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}><X size={14} /></button></div>}
            {connection !== "connected" && <div className="sync-banner"><span className="connection-dot reconnecting" />Reconnecting to the local service. Drafts stay in this window.</div>}
            {externalVersion !== null && !externalDelete && (
              <div className="conflict-banner" role="alert">
                <div><strong>A newer version is available</strong><span>Your draft is preserved. The latest saved version is v{externalVersion}.</span></div>
                <button type="button" onClick={() => void loadLatestVersion()}>Load latest</button>
              </div>
            )}
            {externalDelete && (
              <div className="conflict-banner" role="alert">
                <div><strong>This note was deleted elsewhere</strong><span>Your draft stays open until you choose what to do.</span></div>
                <button type="button" onClick={() => void loadLatestVersion()}>Close draft</button>
              </div>
            )}

            <section className="document-editor" aria-label={activeView === "write" ? "Markdown editor" : "Markdown preview"}>
              <input
                className="title-input"
                type="text"
                value={draftTitle}
                maxLength={160}
                onFocus={(event) => keepEditorControlVisible(event.currentTarget)}
                onChange={(event) => {
                  const nextTitle = event.currentTarget.value;
                  setDraftTitle(nextTitle);
                  rememberDraft(displayDocument, nextTitle, draftBody);
                  setSaveState(externalVersion !== null || externalDelete ? "conflict" : "unsaved");
                  if (notice === "Saved to this Mac.") setNotice("");
                }}
                aria-label="Note title"
              />
              <div className="document-properties" aria-label="Note properties">
                  <div className="document-property-row">
                    <span className="document-property-icon" aria-hidden="true">
                      {saveState === "saving" ? <LoaderCircle className="spin" size={18} />
                        : saveState === "conflict" ? <RefreshCw size={18} />
                          : saveState === "error" ? <X size={18} />
                            : saveState === "unsaved" ? <span className="document-status-unsaved" />
                              : <Check size={18} />}
                    </span>
                    <span className="document-property-label">Status</span>
                    <span className="document-property-value">
                      <span className={`document-state-pill ${saveState}`}><span className={`document-state-dot ${saveState}`} aria-hidden="true" />{saveStateLabel(saveState)}</span>
                    </span>
                  </div>
                  <div className="document-property-row">
                    <span className="document-property-icon" aria-hidden="true"><CalendarDays size={18} /></span>
                    <span className="document-property-label">Created</span>
                    <time className="document-property-value" dateTime={displayDocument.createdAt}>{formatDocumentDate(displayDocument.createdAt)}</time>
                  </div>
                  <label className="document-property-row document-folder-property">
                    <span className="document-property-icon" aria-hidden="true"><Folder size={18} /></span>
                    <span className="document-property-label">Folder</span>
                    <span className="document-property-value">
                      <select
                        aria-label="Move note to folder"
                        value={displayDocument.folderId ?? "root"}
                        disabled={saveState === "saving"}
                        onChange={(event) => void moveDocumentToFolder(event.currentTarget.value === "root" ? null : event.currentTarget.value)}
                      >
                        <option value="root">Unfiled</option>
                        {folders.map((folder) => <option key={folder.id} value={folder.id}>{folderPathById.get(folder.id) ?? folder.name}</option>)}
                      </select>
                    </span>
                  </label>
                  <div className="document-property-row">
                    <span className="document-property-icon" aria-hidden="true"><Clock3 size={18} /></span>
                    <span className="document-property-label">Updated</span>
                    <time className="document-property-value" dateTime={displayDocument.updatedAt}>{formatDocumentDate(displayDocument.updatedAt)}</time>
                  </div>
                  <div className="document-property-row">
                    <span className="document-property-icon" aria-hidden="true"><FileText size={18} /></span>
                    <span className="document-property-label">Version</span>
                    <span className="document-property-value">v{displayDocument.version}</span>
                  </div>
                </div>
              <div className="document-divider" aria-hidden="true" />
              <div ref={editorHostRef} className="fieldnotes-rich-editor" hidden={activeView !== "write"}>
                <MarkdownLiveEditor
                  value={draftBody}
                  adapters={editorAdapters}
                  ariaLabel="Markdown body"
                  minHeight={230}
                  showPreviewTab={false}
                  onFocus={() => {
                    const control = document.activeElement;
                    if (control instanceof HTMLElement) keepEditorControlVisible(control);
                  }}
                  onChange={(nextBody) => {
                    setDraftBody(nextBody);
                    rememberDraft(displayDocument, draftTitle, nextBody);
                    setSaveState(externalVersion !== null || externalDelete ? "conflict" : "unsaved");
                    if (notice === "Saved to this Mac.") setNotice("");
                  }}
                />
              </div>
              <div className="preview-scroll" hidden={activeView !== "preview"}>
                  <MarkdownBody markdown={draftBody} documents={documents} onOpenDocument={(id) => void navigateToDocument(id)} />
                  <section className="backlinks-panel">
                    <div className="backlinks-heading"><Link2 size={15} /><span>LINKED FROM</span><span className="backlink-count">{linkedTitles.length}</span></div>
                    {linkedTitles.length ? (
                      <div className="backlink-list">
                        {linkedTitles.map((document) => <button type="button" key={document.id} onClick={() => void navigateToDocument(document.id)}><FileText size={14} />{document.title}<span>{relativeDate(document.updatedAt)}</span></button>)}
                      </div>
                    ) : <p className="no-backlinks">No notes link here yet. Add <code>[[{draftTitle || "this note"}]]</code> to another note.</p>}
                  </section>
              </div>
              <div className="editor-status">
                <span className="mobile-status">
                  <span className="mobile-sync-state" aria-label={connectionLabel}>
                    <span className={`connection-dot ${connection}`} aria-hidden="true" />
                    {connection === "connected" ? "Live" : connection === "connecting" ? "Connecting" : "Reconnecting"}
                  </span>
                  <span className={`mobile-save-state ${saveState}`} aria-live="polite">{saveStateLabel(saveState)}</span>
                </span>
                <span>{selectedWordCount} words</span>
                <span>{draftBody.length.toLocaleString()} characters</span>
                <span className="save-hint">Changes save when you press <kbd>⌘ S</kbd></span>
              </div>
            </section>
          </>
        ) : screen.kind === "document" ? (
          documentLoadError?.documentId === screen.documentId ? (
            <div className="document-load-error" role="alert">
              <strong>{documentLoadError.message}</strong>
              <button type="button" onClick={() => void ensureDocumentForRoute(screen.documentId)}><RefreshCw size={14} /> Try again</button>
            </div>
          ) : <WorkspaceLoadingSkeleton document />
        ) : documentListStatus === "loading" ? (
          <WorkspaceLoadingSkeleton />
        ) : documentListStatus === "error" ? (
          <div className="workspace-load-error" role="status">
            <strong>The local library could not be loaded.</strong>
            <span>Your notes are still stored locally.</span>
            <button type="button" onClick={() => void refreshDocuments().catch(() => setListError("The local service is unavailable. Reconnecting…"))}><RefreshCw size={14} /> Retry</button>
          </div>
        ) : (
          <>
          {notice && <div className={`notice-bar${saveState === "error" || saveState === "conflict" ? " warning" : ""}`} role="status"><span>{notice}</span><button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}><X size={14} /></button></div>}
          <div className="welcome-state">
            <div className="welcome-art"><span className="art-paper paper-back" /><span className="art-paper paper-front"><span /><span /><span /></span><div className="art-spark spark-one">✳</div><div className="art-spark spark-two">✳</div></div>
            {documents.length > 0 ? (
              <>
                <div className="welcome-kicker">YOUR LIBRARY</div>
                <h2>Choose a note<br />to begin.</h2>
                <p>Your notes are in the list. Select one to read or edit, or create a new note.</p>
              </>
            ) : (
              <>
                <div className="welcome-kicker">A HOME FOR WHAT YOU’RE LEARNING</div>
                <h2>Make a little room<br />for your ideas.</h2>
                <p>Keep thoughts in Markdown, connect them with wikilinks, and pick up where you left off—on this Mac or through your agents.</p>
              </>
            )}
            <button type="button" className="welcome-create" onClick={() => void createAndOpenNote()}><Plus size={16} /> {documents.length > 0 ? "Create a note" : "Create your first note"}</button>
            <div className="welcome-shortcut"><span>Tip</span> Type <code>[[</code> while writing to link another note.</div>
          </div>
          </>
        )}
        </>}
      </main>
    </div>
  );
  };

  const appViewContext: AppViewContextValue = { currentRoute, navigation, renderWorkspace, restoreMobileListScroll };
  const desktopScreen = { ...currentRoute, activityId: "desktop" } as WorkspaceScreen;

  return (
    <>
      {workspaceRenderer === "desktop" ? (
        <div className="desktop-workspace-root" data-fieldnotes-renderer="desktop">
          {renderWorkspace(desktopScreen, navigation)}
        </div>
      ) : (
        <Suspense fallback={<div className="mobile-workspace-root" data-fieldnotes-renderer="mobile-loading" aria-busy="true" />}>
          <MobileWorkspace value={appViewContext} />
        </Suspense>
      )}
      <ActionDialog config={actionDialog} onResolve={resolveActionDialog} />
    </>
  );
}
