import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BookOpen,
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
  Plus,
  RefreshCw,
  Search,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { ApiError, apiRequest, jsonRequest } from "./api";
import { ActionDialog, type ActionDialogConfig, type ActionDialogResult } from "./ActionDialog";
import { AppViewContext, type WorkspaceScreen } from "./AppViewContext";
import { MarkdownBody } from "./MarkdownBody";
import { Stack } from "./stackflow";
import type { ChangeRecord, DocumentRecord, DocumentSummary, FolderRecord } from "./types";

type ConnectionState = "connecting" | "connected" | "reconnecting";
type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";

type DocumentListResponse = { documents: DocumentSummary[] };
type DocumentResponse = { document: DocumentRecord };
type FolderListResponse = { folders: FolderRecord[] };
type FolderResponse = { folder: FolderRecord };
type RecentResponse = { changes: ChangeRecord[] };
type ChangesResponse = { changes: ChangeRecord[]; highWatermark: number };
type BacklinksResponse = { backlinks: DocumentSummary[] };

const LAST_SEQUENCE_KEY = "fieldnotes:last-change-sequence";
type ActiveFolder = string | "root" | null;
type DraftSnapshot = { title: string; body: string; baseVersion: number };

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

export function App() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [visibleDocuments, setVisibleDocuments] = useState<DocumentSummary[]>([]);
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
  const [query, setQuery] = useState("");
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const notesHeadingRef = useRef<HTMLHeadingElement>(null);
  const selectedRef = useRef<DocumentRecord | null>(null);
  const draftTitleRef = useRef("");
  const draftBodyRef = useRef("");
  const queryRef = useRef("");
  const activeFolderRef = useRef<ActiveFolder>(null);
  const sequenceRef = useRef(initialSequence());
  const reconcilingRef = useRef(false);
  const searchRequestRef = useRef(0);
  const folderTreeInitializedRef = useRef(false);
  const draftsRef = useRef(new Map<string, DraftSnapshot>());
  const dialogResolverRef = useRef<((result: ActionDialogResult) => void) | null>(null);
  const navigationPendingRef = useRef(false);

  selectedRef.current = selectedDocument;
  draftTitleRef.current = draftTitle;
  draftBodyRef.current = draftBody;
  queryRef.current = query;
  activeFolderRef.current = activeFolderId;

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
    const requestId = ++searchRequestRef.current;
    const currentFolder = activeFolderRef.current;
    if (!value.trim() && currentFolder === null) {
      setVisibleDocuments(documents);
      return;
    }
    try {
      const response = await apiRequest<DocumentListResponse>(documentListPath(value, currentFolder));
      if (requestId === searchRequestRef.current) setVisibleDocuments(response.documents);
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

  const acceptDocument = useCallback((document: DocumentRecord, restoreDraft = true) => {
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
    setActiveView("write");
    setNotice(versionChanged
      ? "A newer version was saved elsewhere. Your draft is still here."
      : cachedDraft ? "Unsaved draft restored in this tab." : "");
  }, []);

  const ensureDocumentForRoute = useCallback(async (id: string) => {
    setRouteError("");
    if (selectedRef.current?.id === id) return;
    try {
      const response = await apiRequest<DocumentResponse>(`/api/documents/${id}`);
      acceptDocument(response.document);
      void refreshBacklinks(response.document.id);
    } catch {
      setRouteError("This note could not be found. It may have been deleted.");
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveDocument();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
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
      acceptDocument(response.document, false);
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
      acceptDocument(response.document);
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

  const renameActiveFolder = async () => {
    if (!activeFolder) return;
    const name = await requestText({
      title: "Rename folder",
      description: "Choose a name for this folder.",
      label: "Folder name",
      initialValue: activeFolder.name,
      submitLabel: "Save name",
      maxLength: 120,
    });
    if (name === null || name.trim() === activeFolder.name) return;
    try {
      await apiRequest<FolderResponse>(`/api/folders/${activeFolder.id}`, jsonRequest("PUT", {
        expectedVersion: activeFolder.version,
        name,
      }));
      await Promise.all([refreshFolders(), refreshRecent()]);
      setNotice(`Renamed folder to “${name.trim()}”.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not rename the folder.");
    }
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
      acceptDocument(response.document);
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

  const renderWorkspace = (screen: WorkspaceScreen, flow: import("@stackflow/react").Actions, stack: import("@stackflow/core").Stack) => {
    const displayDocument = screen.kind === "document" && selectedDocument?.id === screen.documentId
      ? selectedDocument
      : null;
    const currentActivity = stack.activities.find((activity) => activity.isActive);

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

    const navigateToLibrary = async () => {
      if (screen.kind === "library") {
        setQuery("");
        chooseFolder(null);
        setVisibleDocuments(documents);
        return;
      }
      if (!await confirmDraftLeave()) return;
      setQuery("");
      chooseFolder(null);
      flow.push("Library", {});
    };

    const navigateToRecent = async () => {
      if (screen.kind === "recent" || !await confirmDraftLeave()) return;
      flow.push("Recent", {});
    };

    const navigateToFolder = async (folderId: ActiveFolder) => {
      const routeId = folderId === null ? null : folderId === "root" ? "unfiled" : folderId;
      if (screen.kind === "folder" && screen.folderId === routeId) {
        chooseFolder(folderId);
        return;
      }
      if (!await confirmDraftLeave()) return;
      chooseFolder(folderId);
      setRouteError("");
      if (routeId === null) flow.push("Library", {});
      else flow.push("Folder", { folderId: routeId });
    };

    const navigateToDocument = async (id: string) => {
      if (navigationPendingRef.current) return;
      if (screen.kind === "document" && screen.documentId === id) return;
      navigationPendingRef.current = true;
      try {
        if (!await openDocument(id)) return;
        flow.push("Document", { documentId: id });
      } finally {
        navigationPendingRef.current = false;
      }
    };

    const createAndOpenNote = async () => {
      const created = await createNote();
      if (created) flow.push("Document", { documentId: created.id });
    };

    const navigateBack = () => {
      if (currentActivity?.isRoot) flow.replace("Library", {});
      else flow.pop();
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
      if (await deleteActiveFolder()) flow.replace("Library", {});
    };

    const createFolderAndOpen = async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!await confirmDraftLeave()) return;
      const folder = await createFolderFromForm(event);
      if (folder) flow.push("Folder", { folderId: folder.id });
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

    if (screen.kind === "not-found") {
      return (
        <main id={`fieldnotes-activity-${screen.activityId}`} data-fieldnotes-route="not-found" className="route-not-found">
          <div className="welcome-art" aria-hidden="true"><span className="art-paper paper-back" /><span className="art-paper paper-front"><span /><span /><span /></span></div>
          <h1 className="workspace-title">That page isn’t here.</h1>
          <p>Open your note library to keep working.</p>
          <button type="button" className="welcome-create" onClick={() => flow.replace("Library", {})}>Back to notes</button>
        </main>
      );
    }

    if (screen.kind === "recent") {
      return (
        <main id={`fieldnotes-activity-${screen.activityId}`} data-fieldnotes-route="recent" className="recent-page">
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
        </main>
      );
    }

    return (
    <div id={`fieldnotes-activity-${screen.activityId}`} data-fieldnotes-route={screen.kind} className={`app-shell route-${screen.kind}${displayDocument ? " has-selection" : ""}`}>
      <aside className="left-rail" aria-label="Workspace">
        <div className="brand-lockup">
          <div className="brand-mark"><BookOpen size={18} strokeWidth={2.1} /></div>
          <div>
            <div className="brand-name">Fieldnotes</div>
            <div className="brand-caption">PERSONAL LIBRARY</div>
          </div>
        </div>

        <div className="rail-section-label">YOUR SPACE</div>
        <button className={`rail-link${screen.kind === "library" ? " active" : ""}`} type="button" onClick={() => void navigateToLibrary()}>
          <FileText size={16} />
          <span>All notes</span>
          <span className="rail-count">{documents.length}</span>
        </button>
        <button className="rail-link" type="button" onClick={() => void navigateToRecent()}><Clock3 size={16} /><span>Recent changes</span></button>

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

        <div className="rail-bottom">
          <div className="local-badge"><span className={`connection-dot ${connection}`} />{connectionLabel}</div>
          <p>Stored on this Mac<br />and ready for your agents.</p>
        </div>
      </aside>

      <section className="note-column" aria-label="Notes">
        <div className="list-header">
          <div>
            <div className="eyebrow">YOUR LIBRARY</div>
          <div className="list-title-row"><h1 ref={notesHeadingRef} tabIndex={-1}>{activeFolderId === "root" ? "Unfiled" : activeFolder?.name ?? "Notes"}</h1><span className="total-count">{activeFolderId === null ? documents.length : visibleDocuments.length}</span></div>
          </div>
          <div className="mobile-list-actions">
            <button className="mobile-recent-button" type="button" onClick={() => void navigateToRecent()} aria-label="Recent changes" title="Recent changes"><Clock3 size={18} /></button>
            <button className="icon-button add-note-button" type="button" onClick={() => void createAndOpenNote()} aria-label="Create a note" title="Create a note">
              <Plus size={18} />
            </button>
          </div>
        </div>

        <label className="search-box">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search your notes"
            aria-label="Search all notes"
          />
          {query && <button type="button" className="clear-search" aria-label="Clear search" onClick={() => setQuery("")}><X size={14} /></button>}
          {!query && <kbd>⌘ K</kbd>}
        </label>

        <nav className="folder-browser" aria-label="Folder navigation">
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
            <FileText size={14} /><span>All notes</span><span className="folder-count">{documents.length}</span>
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

        <div className="list-subhead">
          <span>{query ? `${visibleDocuments.length} RESULTS` : activeFolderId === "root" ? "UNFILED NOTES" : activeFolder ? folderPathById.get(activeFolder.id)?.toUpperCase() : "ALL NOTES"}</span>
          <div className="list-tools">
            <button type="button" className="text-tool" onClick={() => fileInputRef.current?.click()} disabled={importing}>
              {importing ? <LoaderCircle className="spin" size={14} /> : <ArrowUpFromLine size={14} />}
              Import
            </button>
            <button type="button" className="text-tool" onClick={() => void exportNotes()} title="Download a JSON export">
              <ArrowDownToLine size={14} /> Export
            </button>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept=".md,.markdown,text/markdown"
              multiple
              onChange={(event) => void importMarkdown(event)}
              aria-label="Select Markdown files to import"
            />
          </div>
        </div>

        {listError && <div className="list-error"><span>{listError}</span><button type="button" onClick={() => void refreshDocuments()}><RefreshCw size={14} /> Retry</button></div>}

        <div className="document-list" role="list">
          {visibleDocuments.map((document) => (
            <button
              className={`document-row${screen.kind === "document" && screen.documentId === document.id ? " selected" : ""}`}
              type="button"
              key={document.id}
              role="listitem"
              onClick={() => void navigateToDocument(document.id)}
            >
              <div className="document-row-top">
                <span className="document-row-title">{document.title}</span>
                <time dateTime={document.updatedAt}>{relativeDate(document.updatedAt)}</time>
              </div>
              <span className="document-excerpt">{document.excerpt || "A new note, ready for a first thought."}</span>
            </button>
          ))}
          {visibleDocuments.length === 0 && !listError && (
            <div className="empty-list">
              <div className="empty-list-icon"><Search size={17} /></div>
              <strong>{query ? "No matching notes" : "Nothing here yet"}</strong>
              <span>{query ? "Try a different title or phrase." : "Create a note to get started."}</span>
              {!query && <button type="button" onClick={() => void createAndOpenNote()}><Plus size={15} /> New note</button>}
            </div>
          )}
        </div>
        <div className="list-footer"><span>{visibleDocuments.length} {visibleDocuments.length === 1 ? "note" : "notes"}</span><span>⌘ S to save</span></div>
      </section>

      <main className="editor-pane" tabIndex={-1}>
        {routeError && <div className="route-error" role="status">{routeError}</div>}
        {displayDocument ? (
          <>
            <header className="editor-toolbar">
              <div className="editor-breadcrumb">
                <button className="mobile-back" type="button" onClick={backFromDocument} aria-label="Back to notes"><ChevronLeft size={18} /></button>
                <span className="breadcrumb-muted">{displayDocument.folderId ? folderPathById.get(displayDocument.folderId)?.toUpperCase() ?? "FOLDER" : "UNFILED"}</span><span className="breadcrumb-divider">/</span>
                <span className="breadcrumb-title">{draftTitle || "Untitled note"}</span>
              </div>
              <div className="toolbar-actions">
                <div className={`save-indicator ${saveState}`}>
                  {saveState === "saving" ? <LoaderCircle className="spin" size={14} /> : saveState === "saved" ? <Check size={14} /> : saveState === "conflict" ? <RefreshCw size={13} /> : <span className="unsaved-dot" />}
                  <span>{saveStateLabel(saveState)}</span>
                </div>
                <div className="view-switch" role="group" aria-label="Editor view">
                  <button type="button" className={activeView === "write" ? "chosen" : ""} onClick={() => setActiveView("write")} aria-pressed={activeView === "write"}>Write</button>
                  <button type="button" className={activeView === "preview" ? "chosen" : ""} onClick={() => setActiveView("preview")} aria-pressed={activeView === "preview"}>Preview</button>
                </div>
                <button type="button" className="save-button" onClick={() => void saveDocument()} disabled={!isDirty || saveState === "saving"}>
                  <Save size={15} /><span>Save</span>
                </button>
                <button className="icon-button toolbar-delete" type="button" onClick={() => void deleteAndReturn()} aria-label="Delete note" title="Delete note"><Trash2 size={16} /></button>
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
                onChange={(event) => {
                  const nextTitle = event.currentTarget.value;
                  setDraftTitle(nextTitle);
                  rememberDraft(displayDocument, nextTitle, draftBody);
                  setSaveState(externalVersion !== null || externalDelete ? "conflict" : "unsaved");
                  if (notice === "Saved to this Mac.") setNotice("");
                }}
                aria-label="Note title"
              />
              <div className="document-meta">
                <span>Markdown note</span><span className="meta-separator">·</span><span>Edited {relativeDate(displayDocument.updatedAt)}</span><span className="meta-separator">·</span><span>v{displayDocument.version}</span>
                <label className="document-folder-label">
                  Folder
                  <select
                    aria-label="Move note to folder"
                    value={displayDocument.folderId ?? "root"}
                    disabled={saveState === "saving"}
                    onChange={(event) => void moveDocumentToFolder(event.currentTarget.value === "root" ? null : event.currentTarget.value)}
                  >
                    <option value="root">Unfiled</option>
                    {folders.map((folder) => <option key={folder.id} value={folder.id}>{folderPathById.get(folder.id) ?? folder.name}</option>)}
                  </select>
                </label>
              </div>
              {activeView === "write" ? (
                <textarea
                  className="markdown-editor"
                  value={draftBody}
                  onChange={(event) => {
                    const nextBody = event.currentTarget.value;
                    setDraftBody(nextBody);
                    rememberDraft(displayDocument, draftTitle, nextBody);
                    setSaveState(externalVersion !== null || externalDelete ? "conflict" : "unsaved");
                    if (notice === "Saved to this Mac.") setNotice("");
                  }}
                  spellCheck
                  aria-label="Markdown body"
                  placeholder="Start with a thought…\n\nUse ## for a heading, - for a list, or [[Note title]] to connect ideas."
                />
              ) : (
                <div className="preview-scroll">
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
              )}
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
        ) : (
          <div className="welcome-state">
            <div className="welcome-art"><span className="art-paper paper-back" /><span className="art-paper paper-front"><span /><span /><span /></span><div className="art-spark spark-one">✳</div><div className="art-spark spark-two">✳</div></div>
            <div className="welcome-kicker">A HOME FOR WHAT YOU’RE LEARNING</div>
            <h2>Make a little room<br />for your ideas.</h2>
            <p>Keep thoughts in Markdown, connect them with wikilinks, and pick up where you left off—on this Mac or through your agents.</p>
            <button type="button" className="welcome-create" onClick={() => void createAndOpenNote()}><Plus size={16} /> Create your first note</button>
            <div className="welcome-shortcut"><span>Tip</span> Type <code>[[</code> while writing to link another note.</div>
          </div>
        )}
      </main>
    </div>
  );
  };

  return (
    <AppViewContext.Provider value={{ renderWorkspace, ensureDocumentForRoute, selectFolderForRoute }}>
      <Stack />
      <ActionDialog config={actionDialog} onResolve={resolveActionDialog} />
    </AppViewContext.Provider>
  );
}
