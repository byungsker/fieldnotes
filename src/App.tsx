import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { ApiError, apiRequest, jsonRequest } from "./api";
import { ActionDialog, type ActionDialogConfig, type ActionDialogResult } from "./ActionDialog";
import type { AppViewContextValue, WorkspaceScreen } from "./AppViewContext";
import { MarkdownLiveEditor } from "../packages/markdown-live-editor";
import { SearchHighlight } from "./SearchHighlight";
import { createFieldnotesEditorAdapters } from "./editor-adapters";
import { formatDocumentDate } from "./document-date";
import { resolveMobileDrawerSwipe, resolveMobileDrawerSwipeDrag } from "./mobile-drawer-swipe";
import { isSidebarToggleShortcut } from "./keyboard-shortcuts";
import {
  AUTOSAVE_DELAY_MS,
  clearLocalDraft,
  draftMatchesDocument,
  isMeaningfulNewDraft,
  readLocalDraft,
  rebaseDraft,
  writeLocalDraft,
  type LocalDraftSnapshot,
} from "./autosave";
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
const MOBILE_DRAWER_HISTORY_KEY = "fieldnotes:mobile-drawer";
const UNFILED_TREE_ID = "__fieldnotes_unfiled__";
const MobileWorkspace = lazy(() => import("./stackflow").then((module) => ({ default: module.MobileWorkspace })));
type ActiveFolder = string | "root" | null;
type DraftSnapshot = LocalDraftSnapshot;
type DraftValues = { title: string; body: string; folderId: string | null; revision: number };
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

function readBrowserDraft(documentId: string): DraftSnapshot | null {
  try {
    return readLocalDraft(documentId, window.localStorage);
  } catch {
    return null;
  }
}

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

function hasDraftChanged(
  document: DocumentRecord | null,
  title: string,
  body: string,
  folderId = document?.folderId ?? null,
): boolean {
  return Boolean(document && (title !== document.title || body !== document.body || folderId !== document.folderId));
}

function pendingDocument(id: string, folderId: string | null, title = "Untitled note", body = ""): DocumentRecord {
  const now = new Date().toISOString();
  return { id, title, body, folderId, createdAt: now, updatedAt: now, version: 0, excerpt: "", contentHash: "" };
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
  const [treeDocuments, setTreeDocuments] = useState<DocumentSummary[]>([]);
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
  const [draftFolderId, setDraftFolderId] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [draftRecoveryAvailable, setDraftRecoveryAvailable] = useState(true);
  const editorAdapters = useMemo(() => createFieldnotesEditorAdapters(), []);
  const [query, setQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("updated-desc");
  const [theme, setTheme] = useState<ColorTheme>(initialTheme);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(initialDesktopSidebarCollapsed);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [reconciliationError, setReconciliationError] = useState(false);
  const [markdownSafeToSave, setMarkdownSafeToSave] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [externalVersion, setExternalVersion] = useState<number | null>(null);
  const [externalDelete, setExternalDelete] = useState(false);
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
  const drawerSearchInputRef = useRef<HTMLInputElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const notesHeadingRef = useRef<HTMLHeadingElement>(null);
  const actionDialogRef = useRef(actionDialog);
  const selectedRef = useRef<DocumentRecord | null>(null);
  const draftTitleRef = useRef("");
  const draftBodyRef = useRef("");
  const draftFolderIdRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const queryRef = useRef("");
  const activeFolderRef = useRef<ActiveFolder>(null);
  const sequenceRef = useRef(initialSequence());
  const reconcilingRef = useRef(false);
  const reconcileChangesRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const reconcileRetryRef = useRef<number | null>(null);
  const markdownSafeToSaveRef = useRef(true);
  const searchRequestRef = useRef(0);
  const treeSearchRequestRef = useRef(0);
  const documentsLoadedRef = useRef(false);
  const folderTreeInitializedRef = useRef(false);
  const draftsRef = useRef(new Map<string, DraftSnapshot>());
  const latestDraftValuesRef = useRef(new Map<string, DraftValues>());
  const documentBasesRef = useRef(new Map<string, DocumentRecord>());
  const pendingCreateRef = useRef(new Set<string>());
  const pendingWritesRef = useRef(new Map<string, DraftSnapshot>());
  const activeWritesRef = useRef(new Set<string>());
  const activeWriteSnapshotsRef = useRef(new Map<string, DraftSnapshot>());
  const conflictedNotesRef = useRef(new Set<string>());
  const saveTimersRef = useRef(new Map<string, number>());
  const dialogResolverRef = useRef<((result: ActionDialogResult) => void) | null>(null);
  const navigationPendingRef = useRef(false);
  const historyIndexRef = useRef(initialHistoryIndex);
  const currentRouteRef = useRef(currentRoute);
  const previousRouteRef = useRef(currentRoute);
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
  draftFolderIdRef.current = draftFolderId;
  queryRef.current = query;
  activeFolderRef.current = activeFolderId;
  actionDialogRef.current = actionDialog;
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
  const rememberDraft = useCallback((document: DocumentRecord | null, title: string, body: string, folderId: string | null) => {
    if (!document) return null;
    const baseline = documentBasesRef.current.get(document.id) ?? document;
    const pendingCreate = pendingCreateRef.current.has(document.id);
    const previous = draftsRef.current.get(document.id);
    const previousValues = latestDraftValuesRef.current.get(document.id);
    const revision = Math.max(previous?.revision ?? 0, previousValues?.revision ?? 0) + 1;
    latestDraftValuesRef.current.set(document.id, { title, body, folderId, revision });
    const initialFolderId = previous ? previous.initialFolderId : document.folderId;
    const changed = pendingCreate
      ? isMeaningfulNewDraft({ title, body, folderId, initialFolderId })
      : hasDraftChanged(baseline, title, body, folderId);
    if (!changed) {
      draftsRef.current.delete(document.id);
      pendingWritesRef.current.delete(document.id);
      try {
        clearLocalDraft(document.id, window.localStorage);
        setDraftRecoveryAvailable(true);
      } catch {
        setDraftRecoveryAvailable(false);
      }
      return null;
    }
    const snapshot: DraftSnapshot = {
      documentId: document.id,
      title,
      body,
      folderId,
      baseVersion: baseline.version,
      baseHash: baseline.contentHash ?? "",
      revision,
      pendingCreate,
      initialFolderId,
    };
    draftsRef.current.set(document.id, snapshot);
    try {
      setDraftRecoveryAvailable(writeLocalDraft(snapshot, window.localStorage));
    } catch {
      setDraftRecoveryAvailable(false);
    }
    return snapshot;
  }, []);

  const isDirty = Boolean(
    selectedDocument &&
      (draftTitle !== selectedDocument.title || draftBody !== selectedDocument.body || draftFolderId !== selectedDocument.folderId),
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
  const orderedTreeDocuments = useMemo(() => {
    const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    return [...treeDocuments].sort((left, right) => {
      if (sortOrder === "title-asc" || sortOrder === "title-desc") {
        const titleOrder = collator.compare(left.title, right.title);
        return (sortOrder === "title-asc" ? titleOrder : -titleOrder) || left.id.localeCompare(right.id);
      }
      const updatedOrder = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
      if (updatedOrder !== 0) return sortOrder === "updated-asc" ? updatedOrder : -updatedOrder;
      return collator.compare(left.title, right.title) || left.id.localeCompare(right.id);
    });
  }, [sortOrder, treeDocuments]);

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
      setTreeDocuments(response.documents);
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
      setExpandedFolderIds(new Set([...response.folders.filter((folder) => folder.parentId === null).map((folder) => folder.id), UNFILED_TREE_ID]));
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

  const refreshExplorerSearch = useCallback(async (value: string) => {
    if (!documentsLoadedRef.current) return;
    const requestId = ++treeSearchRequestRef.current;
    if (!value.trim()) {
      setTreeDocuments(documents);
      setListError("");
      return;
    }
    try {
      const response = await apiRequest<DocumentListResponse>(documentListPath(value, null));
      if (requestId === treeSearchRequestRef.current) {
        setTreeDocuments(response.documents);
        setListError("");
      }
    } catch (error) {
      if (requestId === treeSearchRequestRef.current) {
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
  ) => {
    const knownBase = documentBasesRef.current.get(document.id);
    if (knownBase && knownBase.version > document.version) return;
    setDocumentLoadError(null);
    documentBasesRef.current.set(document.id, document);
    let cachedDraft = restoreDraft
      ? draftsRef.current.get(document.id) ?? readBrowserDraft(document.id) ?? undefined
      : undefined;
    if (!restoreDraft) {
      draftsRef.current.delete(document.id);
      pendingWritesRef.current.delete(document.id);
      conflictedNotesRef.current.delete(document.id);
      try { clearLocalDraft(document.id, window.localStorage); } catch { /* storage may be unavailable */ }
    }
    let versionChanged = false;
    if (cachedDraft?.pendingCreate) {
      cachedDraft = rebaseDraft(cachedDraft, document);
      pendingCreateRef.current.delete(document.id);
      if (draftMatchesDocument(cachedDraft, document)) {
        cachedDraft = undefined;
        draftsRef.current.delete(document.id);
        try { clearLocalDraft(document.id, window.localStorage); } catch { /* storage may be unavailable */ }
      } else {
        draftsRef.current.set(document.id, cachedDraft);
        try { writeLocalDraft(cachedDraft, window.localStorage); } catch { /* storage may be unavailable */ }
      }
    } else if (cachedDraft) {
      versionChanged = cachedDraft.baseVersion !== document.version ||
        Boolean(cachedDraft.baseHash && document.contentHash && cachedDraft.baseHash !== document.contentHash);
      if (draftMatchesDocument(cachedDraft, document)) {
        cachedDraft = undefined;
        draftsRef.current.delete(document.id);
        try { clearLocalDraft(document.id, window.localStorage); } catch { /* storage may be unavailable */ }
      } else {
        draftsRef.current.set(document.id, cachedDraft);
      }
    }
    if (versionChanged) conflictedNotesRef.current.add(document.id);
    else conflictedNotesRef.current.delete(document.id);
    latestDraftValuesRef.current.set(document.id, {
      title: cachedDraft?.title ?? document.title,
      body: cachedDraft?.body ?? document.body,
      folderId: cachedDraft ? cachedDraft.folderId : document.folderId,
      revision: cachedDraft?.revision ?? latestDraftValuesRef.current.get(document.id)?.revision ?? 0,
    });
    selectedRef.current = document;
    setSelectedDocument(document);
    setDraftTitle(cachedDraft?.title ?? document.title);
    setDraftBody(cachedDraft?.body ?? document.body);
    setDraftFolderId(cachedDraft ? cachedDraft.folderId : document.folderId);
    const hasRestoredDraft = Boolean(cachedDraft && !draftMatchesDocument(cachedDraft, document));
    setSaveState(versionChanged ? "conflict" : hasRestoredDraft ? "unsaved" : "saved");
    setExternalVersion(versionChanged ? document.version : null);
    setExternalDelete(false);
    setBacklinks([]);
    markdownSafeToSaveRef.current = true;
    setMarkdownSafeToSave(true);
    try {
      void window.localStorage.length;
      setDraftRecoveryAvailable(true);
    } catch {
      setDraftRecoveryAvailable(false);
    }
    setNotice(versionChanged
      ? "A newer version was saved elsewhere. Your draft is still here."
      : hasRestoredDraft ? "Unsynced draft restored on this device." : "");
  }, []);

  const restoreLocalDraft = useCallback((id: string): boolean => {
    const cachedDraft = draftsRef.current.get(id) ?? readBrowserDraft(id);
    if (!cachedDraft) return false;
    const baseline = pendingDocument(id, cachedDraft.folderId, cachedDraft.title, cachedDraft.body);
    baseline.version = cachedDraft.baseVersion;
    baseline.contentHash = cachedDraft.baseHash;
    documentBasesRef.current.set(id, baseline);
    draftsRef.current.set(id, cachedDraft);
    latestDraftValuesRef.current.set(id, {
      title: cachedDraft.title,
      body: cachedDraft.body,
      folderId: cachedDraft.folderId,
      revision: cachedDraft.revision,
    });
    if (cachedDraft.pendingCreate) pendingCreateRef.current.add(id);
    else pendingCreateRef.current.delete(id);
    selectedRef.current = baseline;
    setSelectedDocument(baseline);
    setDraftTitle(cachedDraft.title);
    setDraftBody(cachedDraft.body);
    setDraftFolderId(cachedDraft.folderId);
    setSaveState("error");
    setExternalVersion(null);
    setExternalDelete(false);
    setBacklinks([]);
    setDraftRecoveryAvailable(true);
    setNotice("Local draft restored. The saved version could not be checked; retry sync when connected.");
    return true;
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
    } catch (error) {
      if (currentRouteRef.current.kind === "document" && currentRouteRef.current.documentId === id) {
        if (restoreLocalDraft(id)) return;
        const missing = error instanceof ApiError && error.status === 404;
        setDocumentLoadError({
          documentId: id,
          message: missing ? "This note could not be found. It may have been deleted." : "The local service is unavailable. Reconnect and retry loading this note.",
        });
      }
    }
  }, [acceptDocument, refreshBacklinks, restoreLocalDraft]);

  const applyIncomingChange = useCallback(async (change: ChangeRecord, refreshCollections = true) => {
    if (change.seq <= sequenceRef.current) return;
    sequenceRef.current = change.seq;
    sessionStorage.setItem(LAST_SEQUENCE_KEY, String(change.seq));

    if (refreshCollections) {
      void refreshDocuments().catch(() => setListError("The note list is temporarily unavailable."));
      void refreshFolders().catch(() => setListError("The folder list is temporarily unavailable."));
      void refreshRecent().catch(() => undefined);
    }

    if (change.entityType === "folder") {
      if (change.operation === "deleted" && activeFolderRef.current === change.folderId) {
        activeFolderRef.current = null;
        setActiveFolderId(null);
      }
      return;
    }
    if (!change.documentId) return;

    const knownBase = documentBasesRef.current.get(change.documentId);
    if (change.operation !== "deleted" && knownBase && change.version <= knownBase.version) return;

    const selected = selectedRef.current;
    if (!selected || selected.id !== change.documentId) return;

    if (change.operation === "deleted") {
      const dirty = hasDraftChanged(selected, draftTitleRef.current, draftBodyRef.current, draftFolderIdRef.current) || draftsRef.current.has(selected.id);
      if (dirty) {
        conflictedNotesRef.current.add(selected.id);
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
      const activeWrite = activeWriteSnapshotsRef.current.get(change.documentId);
      if (activeWrite && draftMatchesDocument(activeWrite, response.document)) {
        documentBasesRef.current.set(change.documentId, response.document);
        selectedRef.current = response.document;
        if (selectedRef.current?.id === change.documentId) setSelectedDocument(response.document);
        return;
      }
      const current = selectedRef.current;
      if (!current || current.id !== change.documentId) return;
      const dirty = hasDraftChanged(current, draftTitleRef.current, draftBodyRef.current, draftFolderIdRef.current) || draftsRef.current.has(current.id);
      if (dirty) {
        documentBasesRef.current.set(change.documentId, response.document);
        conflictedNotesRef.current.add(change.documentId);
        setExternalVersion(response.document.version);
        setSaveState("conflict");
        setNotice("A newer version was saved elsewhere. Your draft is still here.");
      } else {
        acceptDocument(response.document);
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
        // A catch-up page can contain hundreds of events; refresh the collections once after replay.
        for (const change of response.changes) await applyIncomingChange(change, false);
        more = response.changes.length === 500 && sequenceRef.current < response.highWatermark;
      }
      let refreshedSequence: number;
      do {
        refreshedSequence = sequenceRef.current;
        await Promise.all([refreshDocuments(), refreshFolders(), refreshRecent()]);
      } while (sequenceRef.current !== refreshedSequence);
      if (reconcileRetryRef.current !== null) {
        window.clearTimeout(reconcileRetryRef.current);
        reconcileRetryRef.current = null;
      }
      setReconciliationError(false);
    } catch (error) {
      setReconciliationError(true);
      const diagnostic = error instanceof ApiError
        ? { httpStatus: error.status, errorCode: error.code }
        : { errorName: error instanceof Error ? error.name : "unknown" };
      console.warn("[Fieldnotes sync] Change reconciliation failed; the EventSource connection state is unchanged.", diagnostic);
      if (reconcileRetryRef.current === null) {
        reconcileRetryRef.current = window.setTimeout(() => {
          reconcileRetryRef.current = null;
          void reconcileChangesRef.current();
        }, 2_000);
      }
    } finally {
      reconcilingRef.current = false;
    }
  }, [applyIncomingChange, refreshDocuments, refreshFolders, refreshRecent]);
  useEffect(() => {
    reconcileChangesRef.current = reconcileChanges;
  }, [reconcileChanges]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial list loads synchronize the UI with the API.
    void refreshDocuments().catch(() => setListError("The local service is unavailable. Reconnecting…"));
    void refreshFolders().catch(() => setListError("The folder list is temporarily unavailable."));
    void refreshRecent().catch(() => undefined);

    const source = new EventSource(`/api/events?after=${sequenceRef.current}`);
    source.onopen = () => {
      setConnection("connected");
      console.info("[Fieldnotes sync] EventSource opened.");
      void reconcileChanges();
    };
    source.onerror = () => {
      setConnection("reconnecting");
      console.warn("[Fieldnotes sync] EventSource transport error.", { readyState: source.readyState });
    };
    source.addEventListener("change", (event) => {
      try {
        const change = JSON.parse((event as MessageEvent<string>).data) as ChangeRecord;
        // EventSource replays history on reconnect; let reconciliation refresh collections once for the batch.
        void applyIncomingChange(change, !reconcilingRef.current).catch(() => {
          setReconciliationError(true);
          console.warn("[Fieldnotes sync] Applying an SSE change failed; starting catch-up reconciliation.");
          void reconcileChanges();
        });
      } catch {
        setReconciliationError(true);
        console.warn("[Fieldnotes sync] An SSE change payload could not be parsed.");
        void reconcileChanges();
      }
    });
    source.addEventListener("ready", () => setConnection("connected"));
    return () => {
      source.close();
      if (reconcileRetryRef.current !== null) {
        window.clearTimeout(reconcileRetryRef.current);
        reconcileRetryRef.current = null;
      }
    };
  }, [applyIncomingChange, reconcileChanges, refreshDocuments, refreshFolders, refreshRecent]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshSearch(query), 180);
    return () => window.clearTimeout(timer);
  }, [activeFolderId, query, refreshSearch]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshExplorerSearch(query), 180);
    return () => window.clearTimeout(timer);
  }, [query, refreshExplorerSearch]);

  useEffect(() => {
    const previous = previousRouteRef.current;
    const leftDocument = previous.kind === "document" &&
      !(currentRoute.kind === "document" && currentRoute.documentId === previous.documentId);
    previousRouteRef.current = currentRoute;
    if (!leftDocument) return;
    const active = selectedRef.current;
    if (!active || active.id !== previous.documentId) return;
    const snapshot = draftsRef.current.get(active.id) ?? rememberDraft(active, draftTitleRef.current, draftBodyRef.current, draftFolderIdRef.current);
    if (snapshot && !conflictedNotesRef.current.has(active.id)) queueAutosave(snapshot, true);
    // These event helpers read current draft values from refs; the effect should run only on route changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoute]);

  useEffect(() => {
    const active = selectedDocument;
    if (!active || !isDirty || isComposing || !markdownSafeToSave || externalVersion !== null || externalDelete || saveState === "error" || saveState === "conflict") return;
    const snapshot = draftsRef.current.get(active.id);
    if (!snapshot || conflictedNotesRef.current.has(active.id)) return;
    const saveTimers = saveTimersRef.current;
    const timer = window.setTimeout(() => {
      saveTimers.delete(active.id);
      queueAutosave(snapshot, true);
    }, AUTOSAVE_DELAY_MS);
    saveTimers.set(active.id, timer);
    return () => {
      window.clearTimeout(timer);
      if (saveTimers.get(active.id) === timer) saveTimers.delete(active.id);
    };
    // queueAutosave uses ref-backed snapshots and is invoked only for the current render's changed draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDocument, draftTitle, draftBody, draftFolderId, isDirty, isComposing, markdownSafeToSave, externalVersion, externalDelete, saveState]);

  useEffect(() => {
    const warnBeforeClose = (event: BeforeUnloadEvent) => {
      if (draftsRef.current.size === 0 && pendingWritesRef.current.size === 0 && activeWritesRef.current.size === 0) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeClose);
    return () => window.removeEventListener("beforeunload", warnBeforeClose);
  }, []);

  function queueAutosave(snapshot: DraftSnapshot, immediate = false) {
    if (conflictedNotesRef.current.has(snapshot.documentId)) return;
    pendingWritesRef.current.set(snapshot.documentId, snapshot);
    const priorTimer = saveTimersRef.current.get(snapshot.documentId);
    if (priorTimer !== undefined) window.clearTimeout(priorTimer);
    saveTimersRef.current.delete(snapshot.documentId);
    if (immediate) {
      void runAutosaveQueue(snapshot.documentId);
      return;
    }
    const timer = window.setTimeout(() => {
      saveTimersRef.current.delete(snapshot.documentId);
      void runAutosaveQueue(snapshot.documentId);
    }, AUTOSAVE_DELAY_MS);
    saveTimersRef.current.set(snapshot.documentId, timer);
  }

  async function runAutosaveQueue(documentId: string): Promise<void> {
    if (activeWritesRef.current.has(documentId)) return;
    activeWritesRef.current.add(documentId);
    try {
      while (pendingWritesRef.current.has(documentId)) {
        const snapshot = pendingWritesRef.current.get(documentId) as DraftSnapshot;
        pendingWritesRef.current.delete(documentId);
        if (conflictedNotesRef.current.has(documentId)) return;
        if (composingRef.current && selectedRef.current?.id === documentId) {
          pendingWritesRef.current.set(documentId, snapshot);
          return;
        }
        if (selectedRef.current?.id === documentId && !markdownSafeToSaveRef.current) {
          pendingWritesRef.current.set(documentId, snapshot);
          setSaveState("error");
          setNotice("This Markdown draft could not be serialized safely. It is kept locally and has not been synced.");
          return;
        }
        if (!snapshot.title.trim()) {
          pendingWritesRef.current.set(documentId, snapshot);
          if (selectedRef.current?.id === documentId) {
            setSaveState("error");
            setNotice("Add a title to sync this draft. It remains saved in this browser.");
          }
          return;
        }
        if (snapshot.pendingCreate && !isMeaningfulNewDraft(snapshot)) continue;
        const base = documentBasesRef.current.get(documentId);
        if (!snapshot.pendingCreate && !base) {
          pendingWritesRef.current.set(documentId, snapshot);
          if (selectedRef.current?.id === documentId) {
            setSaveState("error");
            setNotice("The saved version is not available yet. Your local draft is preserved.");
          }
          return;
        }

        if (selectedRef.current?.id === documentId) {
          setSaveState("saving");
          setNotice("");
        }
        activeWriteSnapshotsRef.current.set(documentId, snapshot);
        try {
          const response = snapshot.pendingCreate
            ? await apiRequest<DocumentResponse>("/api/documents", jsonRequest("POST", {
                id: documentId,
                title: snapshot.title.trim(),
                body: snapshot.body,
                folderId: snapshot.folderId,
              }))
            : await apiRequest<DocumentResponse>(
                `/api/documents/${documentId}`,
                jsonRequest("PUT", {
                  expectedVersion: snapshot.baseVersion,
                  expectedHash: snapshot.baseHash || undefined,
                  title: snapshot.title.trim(),
                  body: snapshot.body,
                  folderId: snapshot.folderId,
                }),
              );
          const newerObservedVersion = documentBasesRef.current.get(documentId);
          if (newerObservedVersion && newerObservedVersion.version > response.document.version) {
            activeWriteSnapshotsRef.current.delete(documentId);
            const preservedDraft = draftsRef.current.get(documentId) ?? snapshot;
            draftsRef.current.set(documentId, preservedDraft);
            pendingWritesRef.current.delete(documentId);
            conflictedNotesRef.current.add(documentId);
            if (selectedRef.current?.id === documentId) {
              setExternalVersion(newerObservedVersion.version);
              setSaveState("conflict");
              setNotice("A newer version arrived while sync was finishing. Your draft is still here and was not replaced.");
            }
            return;
          }
          documentBasesRef.current.set(documentId, response.document);
          pendingCreateRef.current.delete(documentId);
          activeWriteSnapshotsRef.current.delete(documentId);
          const isActive = selectedRef.current?.id === documentId;
          if (isActive) {
            selectedRef.current = response.document;
            setSelectedDocument(response.document);
          }

          const latestValues = latestDraftValuesRef.current.get(documentId);
          const currentDraft = draftsRef.current.get(documentId);
          const editedAfterRequest = Boolean(latestValues && latestValues.revision > snapshot.revision);
          if (editedAfterRequest && latestValues && !draftMatchesDocument(latestValues, response.document)) {
            const rebased: DraftSnapshot = {
              ...snapshot,
              title: latestValues.title,
              body: latestValues.body,
              folderId: latestValues.folderId,
              baseVersion: response.document.version,
              baseHash: response.document.contentHash ?? "",
              revision: latestValues.revision,
              pendingCreate: false,
            };
            draftsRef.current.set(documentId, rebased);
            try { setDraftRecoveryAvailable(writeLocalDraft(rebased, window.localStorage)); } catch { setDraftRecoveryAvailable(false); }
            pendingWritesRef.current.set(documentId, rebased);
            if (isActive) setSaveState("unsaved");
          } else {
            if (currentDraft && currentDraft.revision <= snapshot.revision) draftsRef.current.delete(documentId);
            pendingWritesRef.current.delete(documentId);
            latestDraftValuesRef.current.set(documentId, {
              title: response.document.title,
              body: response.document.body,
              folderId: response.document.folderId,
              revision: latestValues?.revision ?? snapshot.revision,
            });
            try {
              clearLocalDraft(documentId, window.localStorage);
              if (isActive) setDraftRecoveryAvailable(true);
            } catch { if (isActive) setDraftRecoveryAvailable(false); }
            if (isActive) {
              setDraftTitle(response.document.title);
              setDraftBody(response.document.body);
              setDraftFolderId(response.document.folderId);
              setSaveState("saved");
              setNotice("");
            }
          }
          void Promise.all([refreshDocuments(), refreshFolders(), refreshRecent(), refreshBacklinks(documentId)]).catch(() => undefined);
        } catch (error) {
          activeWriteSnapshotsRef.current.delete(documentId);
          if (error instanceof ApiError && error.code === "version_conflict") {
            conflictedNotesRef.current.add(documentId);
            pendingWritesRef.current.delete(documentId);
            if (selectedRef.current?.id === documentId) {
              setSaveState("conflict");
              setExternalVersion(error.currentVersion ?? null);
              setNotice("A newer version exists. Your draft is preserved and was not synced over it.");
            }
          } else {
            const latestDraft = draftsRef.current.get(documentId) ?? snapshot;
            pendingWritesRef.current.set(documentId, latestDraft);
            if (selectedRef.current?.id === documentId) {
              setSaveState("error");
              setNotice("Changes are kept on this device. Retry sync when the service is available.");
            }
          }
          return;
        }
      }
    } finally {
      activeWritesRef.current.delete(documentId);
    }
  }

  async function saveDocument() {
    const selected = selectedRef.current;
    if (!selected) return;
    if (!markdownSafeToSaveRef.current) {
      setNotice("This Markdown draft could not be serialized safely. It has not been synced.");
      return;
    }
    if (composingRef.current) {
      setNotice("Finish text composition before syncing this draft.");
      return;
    }
    const snapshot = draftsRef.current.get(selected.id) ?? rememberDraft(
      selected,
      draftTitleRef.current,
      draftBodyRef.current,
      draftFolderIdRef.current,
    );
    if (!snapshot) return;
    if (conflictedNotesRef.current.has(selected.id)) return;
    queueAutosave(snapshot, true);
    await runAutosaveQueue(selected.id);
  }

  async function retrySave() {
    const selected = selectedRef.current;
    if (!selected || conflictedNotesRef.current.has(selected.id)) return;
    let snapshot = draftsRef.current.get(selected.id);
    if (!snapshot) {
      snapshot = rememberDraft(selected, draftTitleRef.current, draftBodyRef.current, draftFolderIdRef.current) ?? undefined;
    }
    if (!snapshot) return;
    if (!snapshot.pendingCreate) {
      try {
        const latest = await apiRequest<DocumentResponse>(`/api/documents/${selected.id}`);
        if (latest.document.version !== snapshot.baseVersion || (snapshot.baseHash && latest.document.contentHash !== snapshot.baseHash)) {
          if (draftMatchesDocument(snapshot, latest.document)) {
            acceptDocument(latest.document, false);
            setNotice("The last sync completed before its reply arrived. The current version is loaded.");
          } else {
            documentBasesRef.current.set(selected.id, latest.document);
            conflictedNotesRef.current.add(selected.id);
            setExternalVersion(latest.document.version);
            setSaveState("conflict");
            setNotice("A newer version exists. Review it before syncing your preserved draft.");
          }
          return;
        }
      } catch {
        // The write below remains guarded by its expected version and hash.
      }
    }
    setSaveState("unsaved");
    queueAutosave(snapshot, true);
    await runAutosaveQueue(selected.id);
  }

  async function overwriteLatestWithDraft() {
    const selected = selectedRef.current;
    if (!selected || externalDelete) return;
    if (!await requestConfirm({
      title: "Replace the newer version?",
      description: "This will write your preserved draft over the latest saved note. The other client’s version will remain in its history.",
      confirmLabel: "Replace with my draft",
      destructive: true,
    })) return;
    try {
      const latest = await apiRequest<DocumentResponse>(`/api/documents/${selected.id}`);
      const currentDraft = draftsRef.current.get(selected.id) ?? rememberDraft(selected, draftTitleRef.current, draftBodyRef.current, draftFolderIdRef.current);
      if (!currentDraft) return;
      documentBasesRef.current.set(selected.id, latest.document);
      selectedRef.current = latest.document;
      setSelectedDocument(latest.document);
      const rebased = rebaseDraft(currentDraft, latest.document);
      draftsRef.current.set(selected.id, rebased);
      try { writeLocalDraft(rebased, window.localStorage); } catch { setDraftRecoveryAvailable(false); }
      conflictedNotesRef.current.delete(selected.id);
      setExternalVersion(null);
      setSaveState("unsaved");
      setNotice("");
      queueAutosave(rebased, true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load the latest version for an explicit replacement.");
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || actionDialogRef.current) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("dialog[open], [role='dialog']")) return;
      const isSidebarShortcut = isSidebarToggleShortcut(event);
      if (isSidebarShortcut && workspaceRendererRef.current === "desktop") {
        event.preventDefault();
        if (!event.repeat) {
          setDesktopSidebarCollapsed((collapsed) => !collapsed);
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveDocument();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const searchTarget = workspaceRendererRef.current === "mobile-stackflow" && drawerWasOpenRef.current
          ? drawerSearchInputRef.current
          : searchInputRef.current;
        searchTarget?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // saveDocument reads current values through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createNote = async (): Promise<DocumentRecord | null> => {
    const previous = selectedRef.current;
    if (previous) {
      const snapshot = draftsRef.current.get(previous.id) ?? rememberDraft(previous, draftTitleRef.current, draftBodyRef.current, draftFolderIdRef.current);
      if (snapshot && !conflictedNotesRef.current.has(previous.id)) queueAutosave(snapshot, true);
    }
    const folderId = activeFolderRef.current && activeFolderRef.current !== "root" ? activeFolderRef.current : null;
    const draft = pendingDocument(window.crypto.randomUUID(), folderId);
    pendingCreateRef.current.add(draft.id);
    latestDraftValuesRef.current.set(draft.id, { title: draft.title, body: draft.body, folderId, revision: 0 });
    selectedRef.current = draft;
    setSelectedDocument(draft);
    setDraftTitle(draft.title);
    setDraftBody("");
    setDraftFolderId(folderId);
    setSaveState("unsaved");
    setExternalVersion(null);
    setExternalDelete(false);
    setBacklinks([]);
    setDraftRecoveryAvailable(true);
    setNotice("This note stays a local draft until you start writing.");
    return draft;
  };

  const openDocument = async (id: string): Promise<boolean> => {
    const selected = selectedRef.current;
    if (selected?.id === id) return true;
    if (selected) {
      const snapshot = draftsRef.current.get(selected.id) ?? rememberDraft(selected, draftTitleRef.current, draftBodyRef.current, draftFolderIdRef.current);
      if (snapshot && !conflictedNotesRef.current.has(selected.id)) queueAutosave(snapshot, true);
    }
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
    if (pendingCreateRef.current.has(selected.id)) {
      draftsRef.current.delete(selected.id);
      pendingCreateRef.current.delete(selected.id);
      pendingWritesRef.current.delete(selected.id);
      try { clearLocalDraft(selected.id, window.localStorage); } catch { /* storage may be unavailable */ }
      selectedRef.current = null;
      setSelectedDocument(null);
      setBacklinks([]);
      setNotice("The local new-note draft was discarded.");
      return true;
    }
    try {
      await apiRequest<void>(`/api/documents/${selected.id}`, jsonRequest("DELETE", { expectedVersion: selected.version, expectedHash: selected.contentHash }));
      draftsRef.current.delete(selected.id);
      pendingWritesRef.current.delete(selected.id);
      conflictedNotesRef.current.delete(selected.id);
      documentBasesRef.current.delete(selected.id);
      latestDraftValuesRef.current.delete(selected.id);
      try { clearLocalDraft(selected.id, window.localStorage); } catch { /* storage may be unavailable */ }
      selectedRef.current = null;
      setSelectedDocument(null);
      setBacklinks([]);
      setNotice("Note deleted.");
      await Promise.all([refreshDocuments(), refreshFolders(), refreshRecent()]);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "version_conflict") {
        conflictedNotesRef.current.add(selected.id);
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
      acceptDocument(response.document, false);
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
    if (selectedDocument) {
      const snapshot = draftsRef.current.get(selectedDocument.id) ?? rememberDraft(
        selectedDocument,
        draftTitleRef.current,
        draftBodyRef.current,
        draftFolderIdRef.current,
      );
      if (snapshot && !conflictedNotesRef.current.has(selectedDocument.id)) queueAutosave(snapshot, true);
    }
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
    if (folderId === draftFolderIdRef.current) return;
    setDraftFolderId(folderId);
    rememberDraft(selected, draftTitleRef.current, draftBodyRef.current, folderId);
    if (externalVersion !== null || externalDelete) {
      setSaveState("conflict");
      return;
    }
    setSaveState("unsaved");
    setNotice("Folder change queued with this note’s title and Markdown.");
  };

  const selectedWordCount = useMemo(() => {
    return draftBody.trim() ? draftBody.trim().split(/\s+/).length : 0;
  }, [draftBody]);

  const linkedTitles = useMemo(() => {
    const ids = new Set(backlinks.map((document) => document.id));
    return documents.filter((document) => ids.has(document.id));
  }, [backlinks, documents]);

  const connectionLabel = connection === "connected"
    ? reconciliationError ? "Live stream connected; saved changes need reconciliation" : "Live sync on"
    : connection === "connecting" ? "Connecting" : "Reconnecting";
  const handleMarkdownSerializationSafetyChange = useCallback((safe: boolean) => {
    markdownSafeToSaveRef.current = safe;
    setMarkdownSafeToSave(safe);
  }, []);

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
      const editor = editorHostRef.current?.querySelector<HTMLElement>(".mle-prosemirror");
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
    if (currentRoute.kind !== "document") return;
    const frame = window.requestAnimationFrame(() => {
      const editor = editorHostRef.current?.querySelector<HTMLElement>(".mle-prosemirror");
      if (!editor) return;
      editor.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentRoute.kind, workspaceRenderer]);

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
      if (!selected) return true;
      const snapshot = draftsRef.current.get(selected.id) ?? rememberDraft(
        selected,
        draftTitleRef.current,
        draftBodyRef.current,
        draftFolderIdRef.current,
      );
      if (snapshot && !conflictedNotesRef.current.has(selected.id)) queueAutosave(snapshot, true);
      if (snapshot) setNotice("Your draft is kept on this device while you continue browsing.");
      return true;
    };

    const revealDocumentList = () => setDesktopSidebarCollapsed(false);

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
      const selected = selectedRef.current;
      if (selected) {
        const snapshot = draftsRef.current.get(selected.id) ?? rememberDraft(
          selected,
          draftTitleRef.current,
          draftBodyRef.current,
          draftFolderIdRef.current,
        );
        if (snapshot && !conflictedNotesRef.current.has(selected.id)) queueAutosave(snapshot, true);
        if (snapshot) setNotice("Your draft is kept on this device while you continue browsing.");
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

    const moveExplorerDocument = async (documentId: string, folderId: string | null) => {
      if (selectedRef.current?.id === documentId) {
        await moveDocumentToFolder(folderId);
        return;
      }
      let localDraft: DraftSnapshot | null = draftsRef.current.get(documentId) ?? null;
      if (!localDraft) {
        try { localDraft = readLocalDraft(documentId, window.localStorage); } catch { /* storage may be unavailable */ }
      }
      if (localDraft) {
        setNotice("This note has a local draft. Open it and resolve its sync state before moving it.");
        return;
      }
      try {
        const current = await apiRequest<DocumentResponse>(`/api/documents/${documentId}`);
        await apiRequest<DocumentResponse>(`/api/documents/${documentId}`, jsonRequest("PUT", {
          expectedVersion: current.document.version,
          expectedHash: current.document.contentHash,
          title: current.document.title,
          body: current.document.body,
          folderId,
        }));
        await Promise.all([refreshDocuments(), refreshFolders(), refreshRecent()]);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Could not move this note.");
      }
    };

    const renameExplorerDocument = async (documentId: string) => {
      await navigateToDocument(documentId);
      window.requestAnimationFrame(() => {
        const activeRoot = document.getElementById("fieldnotes-activity-" + activeActivityIdRef.current);
        const titleInput = activeRoot?.querySelector<HTMLInputElement>(".title-input");
        titleInput?.focus({ preventScroll: true });
        titleInput?.select();
      });
    };

    const promptMoveExplorerDocument = async (note: DocumentSummary) => {
      const currentPath = note.folderId ? folderPathById.get(note.folderId) ?? "" : "Unfiled";
      const destination = await requestText({
        title: `Move “${note.title}”`,
        description: "Enter a folder path, or choose Unfiled.",
        label: "Destination folder",
        initialValue: currentPath,
        submitLabel: "Move note",
        maxLength: 240,
      });
      if (destination === null) return;
      const normalized = destination.trim().toLocaleLowerCase();
      if (!normalized || normalized === "unfiled") {
        await moveExplorerDocument(note.id, null);
        return;
      }
      const target = folders.find((folder) => folderPathById.get(folder.id)?.toLocaleLowerCase() === normalized);
      if (!target) {
        setNotice("No folder matches that path. Choose the exact path shown in the tree.");
        return;
      }
      await moveExplorerDocument(note.id, target.id);
    };

    const renderFolderBrowser = (surface: "sidebar" | "drawer") => {
      const folderInputId = "new-folder-name-" + screen.activityId + "-" + surface;
      const queryText = query.trim().toLocaleLowerCase();
      const childrenByParent = new Map<string | null, FolderRecord[]>();
      const documentsByFolder = new Map<string | null, DocumentSummary[]>();
      for (const folder of folders) {
        const siblings = childrenByParent.get(folder.parentId) ?? [];
        siblings.push(folder);
        childrenByParent.set(folder.parentId, siblings);
      }
      for (const children of childrenByParent.values()) children.sort((left, right) => left.name.localeCompare(right.name));
      for (const document of orderedTreeDocuments) {
        const siblings = documentsByFolder.get(document.folderId) ?? [];
        siblings.push(document);
        documentsByFolder.set(document.folderId, siblings);
      }
      const visibleFolderIds = new Set<string>();
      const searchExpanded = new Set(expandedFolderIds);
      const addFolderAndAncestors = (folderId: string | null) => {
        let cursor = folderId ? folders.find((folder) => folder.id === folderId) : undefined;
        while (cursor && !visibleFolderIds.has(cursor.id)) {
          visibleFolderIds.add(cursor.id);
          searchExpanded.add(cursor.id);
          if (cursor.parentId) searchExpanded.add(cursor.parentId);
          cursor = cursor.parentId ? folders.find((folder) => folder.id === cursor?.parentId) : undefined;
        }
      };
      if (!queryText) {
        for (const folder of folders) visibleFolderIds.add(folder.id);
      } else {
        for (const folder of folders) if (folder.name.toLocaleLowerCase().includes(queryText)) addFolderAndAncestors(folder.id);
        for (const document of orderedTreeDocuments) addFolderAndAncestors(document.folderId);
      }
      const visibleChildren = (parentId: string | null) => (childrenByParent.get(parentId) ?? [])
        .filter((folder) => visibleFolderIds.has(folder.id));
      const unfiledOpen = queryText ? true : expandedFolderIds.has(UNFILED_TREE_ID);
      const inputRef = surface === "drawer" ? drawerSearchInputRef : searchInputRef;

      const renderFileRows = (parentId: string | null, depth: number, includeUnfiled = false): React.ReactNode[] => {
        if (parentId === null && !includeUnfiled) return [];
        return (documentsByFolder.get(parentId) ?? []).map((note) => (
          <div className="explorer-tree-row explorer-file-row" key={note.id} style={{ "--tree-depth": depth } as React.CSSProperties}>
            <button
              type="button"
              role="treeitem"
              className={`explorer-file${screen.kind === "document" && screen.documentId === note.id ? " selected" : ""}`}
              data-document-id={note.id}
              aria-current={screen.kind === "document" && screen.documentId === note.id ? "page" : undefined}
              draggable
              title={note.title}
              onDragStart={(event) => {
                event.dataTransfer.setData("application/x-fieldnotes-document", note.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => void navigateToDocument(note.id)}
            >
              <FileText size={14} aria-hidden="true" />
              <span className="explorer-file-copy"><span className="explorer-file-title"><SearchHighlight text={note.title} query={query} /></span><span className="explorer-file-date">{relativeDate(note.updatedAt)}</span></span>
            </button>
            <div className="explorer-file-actions">
              <button type="button" aria-label={`Rename ${note.title}`} title="Rename" onClick={(event) => { event.stopPropagation(); void renameExplorerDocument(note.id); }}><Pencil size={13} /></button>
              <button type="button" aria-label={`Move ${note.title}`} title="Move" onClick={(event) => { event.stopPropagation(); void promptMoveExplorerDocument(note); }}><FolderOpen size={13} /></button>
            </div>
          </div>
        ));
      };

      const renderBranches = (parentId: string | null, depth: number): React.ReactNode[] => {
        const folderRows = visibleChildren(parentId).map((folder) => {
          const nestedFolders = visibleChildren(folder.id);
          const nestedDocuments = documentsByFolder.get(folder.id) ?? [];
          const hasChildren = nestedFolders.length > 0 || nestedDocuments.length > 0;
          const expanded = queryText ? searchExpanded.has(folder.id) : expandedFolderIds.has(folder.id);
          return (
            <Fragment key={folder.id}>
              <div
                className="folder-tree-row explorer-folder-row"
                style={{ "--tree-depth": depth } as React.CSSProperties}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes("application/x-fieldnotes-document")) event.preventDefault();
                }}
                onDrop={(event) => {
                  const documentId = event.dataTransfer.getData("application/x-fieldnotes-document");
                  if (!documentId) return;
                  event.preventDefault();
                  void moveExplorerDocument(documentId, folder.id);
                }}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    className="folder-disclosure"
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${folder.name}`}
                    aria-expanded={expanded}
                    onClick={() => setExpandedFolderIds((current) => {
                      const next = new Set(current);
                      if (next.has(folder.id)) next.delete(folder.id);
                      else next.add(folder.id);
                      return next;
                    })}
                  >{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                ) : <span className="folder-disclosure-spacer" aria-hidden="true" />}
                <button
                  type="button"
                  role="treeitem"
                  aria-expanded={hasChildren ? expanded : undefined}
                  aria-current={activeFolderId === folder.id ? "page" : undefined}
                  className={`folder-nav-item folder-tree-button${activeFolderId === folder.id ? " active" : ""}`}
                  onClick={() => void navigateToFolder(folder.id)}
                >
                  {activeFolderId === folder.id ? <FolderOpen size={15} /> : <Folder size={15} />}
                  <span>{folder.name}</span><span className="folder-count">{folder.documentCount}</span>
                </button>
                <button type="button" className="folder-row-action" aria-label={`Rename ${folder.name}`} onClick={() => void renameFolder(folder.id)}><Pencil size={14} /></button>
              </div>
              {expanded && <div role="group" className="explorer-children">{renderBranches(folder.id, depth + 1)}</div>}
            </Fragment>
          );
        });
        return [...folderRows, ...renderFileRows(parentId, depth)];
      };

      return (
        <nav className={`folder-browser explorer-browser ${surface === "drawer" ? "drawer-folder-browser" : "sidebar-folder-browser"}`} aria-label="Vault files">
          <div className="explorer-search-tools">
            <label className="search-box explorer-search-box">
              <Search size={16} aria-hidden="true" />
              <input
                ref={inputRef}
                type="search"
                className="search-input"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search notes"
                aria-label="Search all notes"
              />
              {query && <button type="button" className="clear-search" aria-label="Clear search" onClick={() => setQuery("")}><X size={14} /></button>}
              {!query && <kbd>⌘ K</kbd>}
            </label>
            <div className="explorer-create-actions">
              <button type="button" className="explorer-new-note" onClick={() => void createAndOpenNote()}><Plus size={15} /> New note</button>
              <button type="button" className="explorer-new-folder" onClick={() => beginFolderCreate(null)}><FolderPlus size={15} /> New folder</button>
            </div>
          </div>
          <div className="folder-browser-header explorer-browser-header">
            <span>VAULT</span>
            <label className="explorer-sort-control"><ArrowDownUp size={13} aria-hidden="true" /><select aria-label="Sort notes" value={sortOrder} onChange={(event) => setSortOrder(event.currentTarget.value as SortOrder)}>
              <option value="updated-desc">Newest</option>
              <option value="updated-asc">Oldest</option>
              <option value="title-asc">A to Z</option>
              <option value="title-desc">Z to A</option>
            </select></label>
          </div>
          {listError && <div className="explorer-search-error" role="status"><span>{listError}</span><button type="button" aria-label="Retry search" onClick={() => void refreshExplorerSearch(query)}><RefreshCw size={13} /></button></div>}
          <div className="explorer-tree" role="tree" aria-label="Folders and notes" aria-busy={documentListStatus === "loading"}>
            <button type="button" role="treeitem" className={`explorer-root-row${screen.kind === "library" ? " selected" : ""}`} aria-current={screen.kind === "library" ? "page" : undefined} onClick={() => void navigateToLibrary()}>
              <BookOpen size={15} /><span>All notes</span><span className="folder-count">{documents.length}</span>
            </button>
            <div
              className="folder-tree-row explorer-folder-row explorer-unfiled-row"
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("application/x-fieldnotes-document")) event.preventDefault();
              }}
              onDrop={(event) => {
                const documentId = event.dataTransfer.getData("application/x-fieldnotes-document");
                if (!documentId) return;
                event.preventDefault();
                void moveExplorerDocument(documentId, null);
              }}
            >
              <button type="button" className="folder-disclosure" aria-label={`${unfiledOpen ? "Collapse" : "Expand"} Unfiled`} aria-expanded={unfiledOpen} onClick={() => setExpandedFolderIds((current) => {
                const next = new Set(current);
                if (next.has(UNFILED_TREE_ID)) next.delete(UNFILED_TREE_ID);
                else next.add(UNFILED_TREE_ID);
                return next;
              })}>{unfiledOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
              <button type="button" role="treeitem" aria-expanded={unfiledOpen} className={`folder-nav-item folder-tree-button${activeFolderId === "root" ? " active" : ""}`} onClick={() => void navigateToFolder("root")}>
                <Folder size={15} /><span>Unfiled</span><span className="folder-count">{documents.filter((document) => document.folderId === null).length}</span>
              </button>
            </div>
            {unfiledOpen && <div role="group" className="explorer-children">{renderFileRows(null, 1, true)}</div>}
            {renderBranches(null, 0)}
            {documentListStatus === "loaded" && orderedTreeDocuments.length === 0 && queryText && <p className="explorer-empty">No matching notes.</p>}
            {documentListStatus === "loaded" && documents.length === 0 && !queryText && <p className="explorer-empty">No notes yet. Create one to begin.</p>}
          </div>
          {creatingFolderParent !== undefined && (
            <form className="folder-create-form" onSubmit={(event) => void createFolderAndOpen(event)}>
              <label htmlFor={folderInputId}>{creatingFolderParent ? `New subfolder in ${folderPathById.get(creatingFolderParent) ?? "folder"}` : "New top-level folder"}</label>
              <input id={folderInputId} value={newFolderName} onChange={(event) => setNewFolderName(event.currentTarget.value)} maxLength={120} autoFocus={surface === "drawer" ? showDrawer : true} required />
              <div><button type="submit">Create</button><button type="button" onClick={() => setCreatingFolderParent(undefined)}>Cancel</button></div>
            </form>
          )}
          {activeFolder && (
            <div className="folder-admin" aria-label={`${activeFolder.name} folder actions`}>
              <div className="folder-admin-actions">
                <button type="button" onClick={() => beginFolderCreate(activeFolder.id)}><FolderPlus size={13} /> Subfolder</button>
                <button type="button" onClick={() => void renameActiveFolder()}>Rename</button>
                <button type="button" onClick={() => void deleteFolderAndReturn()}>Delete empty</button>
              </div>
              <label className="folder-move-label">Move folder
                <select value={activeFolder.parentId ?? "root"} onChange={(event) => void moveActiveFolder(event.currentTarget.value)} aria-label={`Move ${activeFolder.name} to parent folder`}>
                  <option value="root">Top level</option>
                  {folders.filter((folder) => !excludedFolderParents.has(folder.id)).map((folder) => <option key={folder.id} value={folder.id}>{folderPathById.get(folder.id) ?? folder.name}</option>)}
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
      className={`app-shell route-${screen.kind}${displayDocument ? " has-selection" : ""}${workspaceRenderer === "desktop" ? " sidebar-explorer-layout" : ""}${workspaceRenderer === "desktop" && desktopSidebarCollapsed ? " sidebar-collapsed" : ""}`}
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
              aria-label={desktopSidebarCollapsed ? "Expand sidebar (⌘+|)" : "Collapse sidebar (⌘+|)"}
              aria-keyshortcuts="Meta+Shift+Backslash"
              aria-expanded={!desktopSidebarCollapsed}
              onClick={() => setDesktopSidebarCollapsed((collapsed) => !collapsed)}
            >
              {desktopSidebarCollapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
            </button>
          )}
        </div>

        {workspaceRenderer === "desktop" && renderFolderBrowser("sidebar")}
        {workspaceRenderer === "desktop" && <div className="sidebar-data-actions">{renderListTools("desktop")}</div>}
        {workspaceRenderer === "desktop" && <button className={`rail-link${screen.kind === "recent" ? " active" : ""}`} type="button" aria-label="Recent changes" onClick={() => void navigateToRecent()}><Clock3 size={16} /><span>Recent changes</span></button>}
        {workspaceRenderer === "mobile-stackflow" && <>
          <div className="rail-section-label">YOUR SPACE</div>
          <button className={`rail-link${screen.kind === "library" ? " active" : ""}`} type="button" aria-label="All notes" onClick={() => void navigateToLibrary()}>
            <FileText size={16} /><span>All notes</span>
            <span className="rail-count">{documentListStatus === "loaded" ? documents.length : <span className="count-skeleton" role="status" aria-label="Loading note count" />}</span>
          </button>
          <button className={`rail-link${screen.kind === "recent" ? " active" : ""}`} type="button" aria-label="Recent changes" onClick={() => void navigateToRecent()}><Clock3 size={16} /><span>Recent changes</span></button>
          {renderFolderBrowser("drawer")}
        </>}

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
            <button className="icon-button theme-toggle theme-toggle-list" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button className="mobile-recent-button" type="button" onClick={() => void navigateToRecent()} aria-label="Recent changes"><Clock3 size={18} /></button>
            <button className="icon-button add-note-button" type="button" onClick={() => void createAndOpenNote()} aria-label="Create a note">
              <Plus size={18} />
            </button>
          </div>
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

        <div className="list-subhead">
          <span>{documentListStatus === "loading" ? "LOADING NOTES" : query ? `${visibleDocuments.length} RESULTS` : activeFolderId === "root" ? "UNFILED NOTES" : activeFolder ? folderPathById.get(activeFolder.id)?.toUpperCase() : "ALL NOTES"}</span>
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
        <div className="list-footer"><span>{documentListStatus === "loading" ? "Loading notes…" : documentListStatus === "error" ? "Notes unavailable" : `${visibleDocuments.length} ${visibleDocuments.length === 1 ? "note" : "notes"}`}</span><span>Autosaves while you write</span></div>
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
                <span className="breadcrumb-muted">{draftFolderId ? folderPathById.get(draftFolderId) ?? "Folder" : "Unfiled"}</span><span className="breadcrumb-divider">/</span>
                <span className="breadcrumb-title">{draftTitle || "Untitled note"}</span>
              </div>
              <div className="toolbar-actions">
                <div className={`save-indicator ${saveState}`}>
                  {saveState === "saving" ? <LoaderCircle className="spin" size={14} /> : saveState === "saved" ? <Check size={14} /> : saveState === "conflict" ? <RefreshCw size={13} /> : <span className="unsaved-dot" />}
                  <span>{saveStateLabel(saveState)}</span>
                </div>
                {saveState === "error" && <button type="button" className="autosave-retry" onClick={() => void retrySave()}>Retry</button>}
                <button className="icon-button toolbar-delete" type="button" onClick={() => void deleteAndReturn()} aria-label="Delete note"><Trash2 size={16} /></button>
                <button className="icon-button theme-toggle theme-toggle-editor" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
                  {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
                </button>
              </div>
            </header>

            {notice && <div className={`notice-bar${saveState === "error" || saveState === "conflict" ? " warning" : ""}`} role="status"><span>{notice}</span><button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}><X size={14} /></button></div>}
            {!draftRecoveryAvailable && <div className="notice-bar warning" role="status"><span>This browser could not keep a local recovery copy. Keep this tab open until sync completes.</span></div>}
            {(connection !== "connected" || reconciliationError) && <div className="sync-banner"><span className={`connection-dot ${connection === "connected" ? "connected" : "reconnecting"}`} />{connection !== "connected" ? "Reconnecting to the local service. Drafts stay in this window." : "The live stream is connected, but saved changes still need reconciliation."}{connection === "connected" && <button type="button" onClick={() => void reconcileChanges()}>Retry sync</button>}</div>}
            {externalVersion !== null && !externalDelete && (
              <div className="conflict-banner" role="alert">
                <div><strong>A newer version is available</strong><span>Your draft is preserved. The latest saved version is v{externalVersion}.</span></div>
                <div className="conflict-actions">
                  <button type="button" onClick={() => void loadLatestVersion()}>Load latest</button>
                  <button type="button" onClick={() => void overwriteLatestWithDraft()}>Replace with my draft</button>
                </div>
              </div>
            )}
            {externalDelete && (
              <div className="conflict-banner" role="alert">
                <div><strong>This note was deleted elsewhere</strong><span>Your draft stays open until you choose what to do.</span></div>
                <button type="button" onClick={() => void loadLatestVersion()}>Close draft</button>
              </div>
            )}

            <section className="document-editor" aria-label="Markdown editor">
              <input
                className="title-input"
                type="text"
                value={draftTitle}
                maxLength={160}
                onFocus={(event) => keepEditorControlVisible(event.currentTarget)}
                onCompositionStart={() => { composingRef.current = true; setIsComposing(true); }}
                onCompositionEnd={() => { composingRef.current = false; setIsComposing(false); }}
                onChange={(event) => {
                  const nextTitle = event.currentTarget.value;
                  setDraftTitle(nextTitle);
                  rememberDraft(selectedRef.current, nextTitle, draftBodyRef.current, draftFolderIdRef.current);
                  setSaveState(externalVersion !== null || externalDelete ? "conflict" : "unsaved");
                  if (notice) setNotice("");
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
                        value={draftFolderId ?? "root"}
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
              <div
                ref={editorHostRef}
                className="fieldnotes-rich-editor"
                onCompositionStartCapture={() => { composingRef.current = true; setIsComposing(true); }}
                onCompositionEndCapture={() => { composingRef.current = false; setIsComposing(false); }}
              >
                <MarkdownLiveEditor
                  value={draftBody}
                  adapters={editorAdapters}
                  ariaLabel="Markdown body"
                  minHeight={230}
                  onFocus={() => {
                    const control = document.activeElement;
                    if (control instanceof HTMLElement) keepEditorControlVisible(control);
                  }}
                  onChange={(nextBody) => {
                    setDraftBody(nextBody);
                    rememberDraft(selectedRef.current, draftTitleRef.current, nextBody, draftFolderIdRef.current);
                    setSaveState(externalVersion !== null || externalDelete ? "conflict" : "unsaved");
                    if (notice) setNotice("");
                  }}
                  onSerializationSafetyChange={handleMarkdownSerializationSafetyChange}
                />
              </div>
              <section className="backlinks-panel">
                <div className="backlinks-heading"><Link2 size={15} /><span>LINKED FROM</span><span className="backlink-count">{linkedTitles.length}</span></div>
                {linkedTitles.length ? (
                  <div className="backlink-list">
                    {linkedTitles.map((document) => <button type="button" key={document.id} onClick={() => void navigateToDocument(document.id)}><FileText size={14} />{document.title}<span>{relativeDate(document.updatedAt)}</span></button>)}
                  </div>
                ) : <p className="no-backlinks">No notes link here yet. Add <code>[[{draftTitle || "this note"}]]</code> to another note.</p>}
              </section>
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
                <span className="save-hint">Changes save automatically · <kbd>⌘ S</kbd> sync now</span>
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
