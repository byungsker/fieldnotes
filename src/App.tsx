import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BookOpen,
  Check,
  ChevronLeft,
  Clock3,
  FileText,
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
import { MarkdownBody } from "./MarkdownBody";
import type { ChangeRecord, DocumentRecord, DocumentSummary } from "./types";

type ConnectionState = "connecting" | "connected" | "reconnecting";
type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";

type DocumentListResponse = { documents: DocumentSummary[] };
type DocumentResponse = { document: DocumentRecord };
type RecentResponse = { changes: ChangeRecord[] };
type ChangesResponse = { changes: ChangeRecord[]; highWatermark: number };
type BacklinksResponse = { backlinks: DocumentSummary[] };

const LAST_SEQUENCE_KEY = "fieldnotes:last-change-sequence";

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const notesHeadingRef = useRef<HTMLHeadingElement>(null);
  const editorPaneRef = useRef<HTMLElement>(null);
  const selectedRef = useRef<DocumentRecord | null>(null);
  const draftTitleRef = useRef("");
  const draftBodyRef = useRef("");
  const queryRef = useRef("");
  const sequenceRef = useRef(initialSequence());
  const reconcilingRef = useRef(false);
  const searchRequestRef = useRef(0);

  selectedRef.current = selectedDocument;
  draftTitleRef.current = draftTitle;
  draftBodyRef.current = draftBody;
  queryRef.current = query;
  const selectedDocumentId = selectedDocument?.id;

  useEffect(() => {
    if (!selectedDocumentId || !window.matchMedia("(max-width: 820px)").matches) return;
    const frame = window.requestAnimationFrame(() => editorPaneRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedDocumentId]);

  const isDirty = Boolean(
    selectedDocument &&
      (draftTitle !== selectedDocument.title || draftBody !== selectedDocument.body),
  );

  const refreshDocuments = useCallback(async () => {
    const response = await apiRequest<DocumentListResponse>("/api/documents");
    setDocuments(response.documents);
    if (!queryRef.current.trim()) setVisibleDocuments(response.documents);
    else {
      const search = await apiRequest<DocumentListResponse>(`/api/documents?q=${encodeURIComponent(queryRef.current)}`);
      setVisibleDocuments(search.documents);
    }
    setListError("");
  }, []);

  const refreshSearch = useCallback(async (value: string) => {
    const requestId = ++searchRequestRef.current;
    if (!value.trim()) {
      setVisibleDocuments(documents);
      return;
    }
    try {
      const response = await apiRequest<DocumentListResponse>(`/api/documents?q=${encodeURIComponent(value)}`);
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

  const acceptDocument = useCallback((document: DocumentRecord) => {
    selectedRef.current = document;
    setSelectedDocument(document);
    setDraftTitle(document.title);
    setDraftBody(document.body);
    setSaveState("saved");
    setExternalVersion(null);
    setExternalDelete(false);
    setBacklinks([]);
    setActiveView("write");
    setNotice("");
  }, []);

  const applyIncomingChange = useCallback(async (change: ChangeRecord) => {
    if (change.seq <= sequenceRef.current) return;
    sequenceRef.current = change.seq;
    sessionStorage.setItem(LAST_SEQUENCE_KEY, String(change.seq));

    void refreshDocuments().catch(() => setListError("The note list is temporarily unavailable."));
    void refreshRecent().catch(() => undefined);

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
  }, [acceptDocument, refreshBacklinks, refreshDocuments, refreshRecent]);

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
      await Promise.all([refreshDocuments(), refreshRecent()]);
      setConnection("connected");
    } catch {
      setConnection("reconnecting");
    } finally {
      reconcilingRef.current = false;
    }
  }, [applyIncomingChange, refreshDocuments, refreshRecent]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial list loads synchronize the UI with the API.
    void refreshDocuments().catch(() => setListError("The local service is unavailable. Reconnecting…"));
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
  }, [applyIncomingChange, reconcileChanges, refreshDocuments, refreshRecent]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshSearch(query), 180);
    return () => window.clearTimeout(timer);
  }, [query, refreshSearch]);

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
      if (event.key === "Escape" && selectedRef.current && window.innerWidth <= 820) {
        selectedRef.current = null;
        setSelectedDocument(null);
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
      acceptDocument(response.document);
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

  const createNote = async () => {
    if (isDirty && !window.confirm("Leave this draft without saving?")) return;
    try {
      const response = await apiRequest<DocumentResponse>("/api/documents", jsonRequest("POST", { title: "Untitled note", body: "" }));
      acceptDocument(response.document);
      await Promise.all([refreshDocuments(), refreshRecent()]);
      void refreshBacklinks(response.document.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not create a note.");
    }
  };

  const openDocument = async (id: string) => {
    const selected = selectedRef.current;
    if (selected && selected.id !== id &&
      (draftTitleRef.current !== selected.title || draftBodyRef.current !== selected.body) &&
      !window.confirm("Leave this draft without saving?")) return;
    try {
      const response = await apiRequest<DocumentResponse>(`/api/documents/${id}`);
      acceptDocument(response.document);
      void refreshBacklinks(response.document.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not open this note.");
    }
  };

  const deleteCurrentDocument = async () => {
    const selected = selectedRef.current;
    if (!selected) return;
    if (!window.confirm(`Delete “${selected.title}”? This cannot be undone.`)) return;
    try {
      await apiRequest<void>(`/api/documents/${selected.id}`, jsonRequest("DELETE", { expectedVersion: selected.version }));
      selectedRef.current = null;
      setSelectedDocument(null);
      setBacklinks([]);
      setNotice("Note deleted.");
      await Promise.all([refreshDocuments(), refreshRecent()]);
    } catch (error) {
      if (error instanceof ApiError && error.code === "version_conflict") {
        setSaveState("conflict");
        setExternalVersion(error.currentVersion ?? null);
        setNotice("This note changed elsewhere and was not deleted. Load the latest version first.");
      } else {
        setNotice(error instanceof Error ? error.message : "Could not delete this note.");
      }
    }
  };

  const loadLatestVersion = async () => {
    const selected = selectedRef.current;
    if (!selected) return;
    if (externalDelete) {
      selectedRef.current = null;
      setSelectedDocument(null);
      setBacklinks([]);
      setExternalDelete(false);
      setNotice("The deleted note and its draft were closed.");
      return;
    }
    try {
      const response = await apiRequest<DocumentResponse>(`/api/documents/${selected.id}`);
      acceptDocument(response.document);
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
    if (isDirty && !window.confirm("Import notes and leave the current draft without saving?")) return;
    setImporting(true);
    setNotice("");
    try {
      const documentsToImport = await Promise.all(
        files.map(async (file) => {
          const filename = file.name.replace(/\.(markdown|md)$/i, "").trim();
          return { title: filename || "Imported note", body: await file.text() };
        }),
      );
      const response = await apiRequest<{ documents: DocumentRecord[] }>(
        "/api/import",
        jsonRequest("POST", { documents: documentsToImport }),
      );
      await Promise.all([refreshDocuments(), refreshRecent()]);
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

  const openFromRecent = (change: ChangeRecord) => {
    if (change.operation === "deleted") {
      setNotice(`“${change.title}” was deleted.`);
      return;
    }
    void openDocument(change.documentId);
  };

  const selectedWordCount = useMemo(() => {
    return draftBody.trim() ? draftBody.trim().split(/\s+/).length : 0;
  }, [draftBody]);

  const linkedTitles = useMemo(() => {
    const ids = new Set(backlinks.map((document) => document.id));
    return documents.filter((document) => ids.has(document.id));
  }, [backlinks, documents]);

  const connectionLabel = connection === "connected" ? "Live sync on" : connection === "connecting" ? "Connecting" : "Reconnecting";

  return (
    <div className={`app-shell${selectedDocument ? " has-selection" : ""}`}>
      <aside className="left-rail" aria-label="Workspace">
        <div className="brand-lockup">
          <div className="brand-mark"><BookOpen size={18} strokeWidth={2.1} /></div>
          <div>
            <div className="brand-name">Fieldnotes</div>
            <div className="brand-caption">PERSONAL LIBRARY</div>
          </div>
        </div>

        <div className="rail-section-label">YOUR SPACE</div>
        <button className="rail-link active" type="button" onClick={() => { setQuery(""); setVisibleDocuments(documents); }}>
          <FileText size={16} />
          <span>All notes</span>
          <span className="rail-count">{documents.length}</span>
        </button>
        <div className="rail-link rail-link-static"><Clock3 size={16} /><span>Recent changes</span></div>

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
              onClick={() => openFromRecent(change)}
              title={`${operationLabel(change.operation)} ${change.title}`}
            >
              <span className={`activity-indicator ${change.operation}`} aria-hidden="true" />
              <span className="activity-copy">
                <span className="activity-title">{change.title}</span>
                <span className="activity-meta">{operationLabel(change.operation)} · {relativeDate(change.createdAt)}</span>
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
          <div className="list-title-row"><h1 ref={notesHeadingRef} tabIndex={-1}>Notes</h1><span className="total-count">{documents.length}</span></div>
          </div>
          <button className="icon-button add-note-button" type="button" onClick={() => void createNote()} aria-label="Create a note" title="Create a note">
            <Plus size={18} />
          </button>
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

        <div className="list-subhead">
          <span>{query ? `${visibleDocuments.length} RESULTS` : "ALL NOTES"}</span>
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
              className={`document-row${selectedDocument?.id === document.id ? " selected" : ""}`}
              type="button"
              key={document.id}
              role="listitem"
              onClick={() => void openDocument(document.id)}
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
              {!query && <button type="button" onClick={() => void createNote()}><Plus size={15} /> New note</button>}
            </div>
          )}
        </div>
        <div className="list-footer"><span>{visibleDocuments.length} {visibleDocuments.length === 1 ? "note" : "notes"}</span><span>⌘ S to save</span></div>
      </section>

      <main className="editor-pane" ref={editorPaneRef} tabIndex={-1}>
        {selectedDocument ? (
          <>
            <header className="editor-toolbar">
              <div className="editor-breadcrumb">
                <button className="mobile-back" type="button" onClick={() => { selectedRef.current = null; setSelectedDocument(null); window.requestAnimationFrame(() => notesHeadingRef.current?.focus()); }} aria-label="Back to notes"><ChevronLeft size={18} /></button>
                <span className="breadcrumb-muted">NOTES</span><span className="breadcrumb-divider">/</span>
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
                <button className="icon-button toolbar-delete" type="button" onClick={() => void deleteCurrentDocument()} aria-label="Delete note" title="Delete note"><Trash2 size={16} /></button>
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
                  setDraftTitle(event.currentTarget.value);
                  setSaveState(externalVersion !== null || externalDelete ? "conflict" : "unsaved");
                  if (notice === "Saved to this Mac.") setNotice("");
                }}
                aria-label="Note title"
              />
              <div className="document-meta"><span>Markdown note</span><span className="meta-separator">·</span><span>Edited {relativeDate(selectedDocument.updatedAt)}</span><span className="meta-separator">·</span><span>v{selectedDocument.version}</span></div>
              {activeView === "write" ? (
                <textarea
                  className="markdown-editor"
                  value={draftBody}
                  onChange={(event) => {
                    setDraftBody(event.currentTarget.value);
                    setSaveState(externalVersion !== null || externalDelete ? "conflict" : "unsaved");
                    if (notice === "Saved to this Mac.") setNotice("");
                  }}
                  spellCheck
                  aria-label="Markdown body"
                  placeholder="Start with a thought…\n\nUse ## for a heading, - for a list, or [[Note title]] to connect ideas."
                />
              ) : (
                <div className="preview-scroll">
                  <MarkdownBody markdown={draftBody} documents={documents} onOpenDocument={(id) => void openDocument(id)} />
                  <section className="backlinks-panel">
                    <div className="backlinks-heading"><Link2 size={15} /><span>LINKED FROM</span><span className="backlink-count">{linkedTitles.length}</span></div>
                    {linkedTitles.length ? (
                      <div className="backlink-list">
                        {linkedTitles.map((document) => <button type="button" key={document.id} onClick={() => void openDocument(document.id)}><FileText size={14} />{document.title}<span>{relativeDate(document.updatedAt)}</span></button>)}
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
            <button type="button" className="welcome-create" onClick={() => void createNote()}><Plus size={16} /> Create your first note</button>
            <div className="welcome-shortcut"><span>Tip</span> Type <code>[[</code> while writing to link another note.</div>
          </div>
        )}
      </main>
    </div>
  );
}
