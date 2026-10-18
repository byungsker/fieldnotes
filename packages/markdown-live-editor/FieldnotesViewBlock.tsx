import { useEffect, useMemo, useRef, useState } from "react";
import { Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import type { FieldnotesViewConfig, VisualizationAction, VisualizationNote, VisualizationQueryResponse, VisualizationTrashNote, VisualizationUiEvent, VisualizationValue } from "./visualization-contract.js";
import { parseFieldnotesViewConfig } from "./fieldnotes-view-config.ts";
import { SandboxedVisualization } from "./SandboxedVisualization.tsx";
import type { MarkdownLiveEditorAdapters } from "./types.ts";

type FieldnotesViewOptions = Pick<MarkdownLiveEditorAdapters,
  "queryVisualization" | "subscribeToVaultChanges" | "enableCustomVisualizations" | "executeVisualizationAction"> & {
    visualizationDocumentId?: string;
    visualizationTrustAdapter: {
      isTrusted: (documentId: string, blockIndex: number, sourceHash: string) => boolean;
      trust?: (documentId: string, blockIndex: number, sourceHash: string) => void;
      revoke?: (documentId: string, blockIndex: number, sourceHash: string) => void;
    };
    runVisualizationAction: (action: VisualizationAction) => Promise<Record<string, unknown>>;
    openVisualizationNote: (noteId: string) => Promise<void>;
  };

const EMPTY_VISUALIZATION_NOTES: VisualizationNote[] = [];
const EMPTY_VISUALIZATION_TRASH: VisualizationTrashNote[] = [];

function valueAt(note: VisualizationNote, field: string): VisualizationValue | undefined {
  if (field === "title" || field === "path" || field === "createdAt" || field === "updatedAt" || field === "excerpt") return note[field];
  if (!field.startsWith("frontmatter.")) return undefined;
  let value: VisualizationValue | undefined = note.frontmatter;
  for (const key of field.slice("frontmatter.".length).split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    if (!Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function displayValue(value: VisualizationValue | undefined, field?: string): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") {
    if (["createdAt", "updatedAt"].includes(field ?? "")) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => displayValue(item)).join(", ");
  return JSON.stringify(value);
}

function fieldLabel(field: string): string {
  return field.startsWith("frontmatter.") ? field.slice("frontmatter.".length).replaceAll(".", " · ") : field;
}

function TableVisualization({ notes, config }: { notes: VisualizationNote[]; config: FieldnotesViewConfig }) {
  const columns = config.columns?.length ? config.columns : ["title", "path", "updatedAt"];
  return (
    <>
      <p className="mle-fieldnotes-table-scroll-hint">Swipe or scroll sideways to see all columns.</p>
      <div className="mle-fieldnotes-table-scroll" role="region" aria-label="Notes table. Scroll horizontally for additional columns." tabIndex={0}>
        <table className="mle-fieldnotes-table">
          <thead><tr>{columns.map((field) => <th scope="col" key={field}>{fieldLabel(field)}</th>)}</tr></thead>
          <tbody>
            {notes.map((note) => (
              <tr key={note.id}>
                {columns.map((field) => <td key={field} data-label={fieldLabel(field)}>{displayValue(valueAt(note, field), field)}</td>)}
              </tr>
            ))}
            {!notes.length && <tr><td colSpan={columns.length}>No notes match this view.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

type CalendarEvent = { note: VisualizationNote; date: Date; label: string };

function calendarDate(value: VisualizationValue | undefined): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function CalendarVisualization({ notes, config }: { notes: VisualizationNote[]; config: FieldnotesViewConfig }) {
  const dateField = config.dateField || "updatedAt";
  const labelField = config.labelField || "title";
  const events: CalendarEvent[] = notes.flatMap((note) => {
    const date = calendarDate(valueAt(note, dateField));
    return date ? [{ note, date, label: displayValue(valueAt(note, labelField)) }] : [];
  });
  const monthGroups = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = `${event.date.getFullYear()}-${String(event.date.getMonth() + 1).padStart(2, "0")}`;
    monthGroups.set(key, [...(monthGroups.get(key) ?? []), event]);
  }
  const weekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2024, 0, 7 + index)));
  const months = [...monthGroups.entries()].sort(([left], [right]) => left.localeCompare(right));

  return (
    <div className="mle-fieldnotes-calendar">
      {months.map(([monthKey, monthEvents]) => {
        const [year = "1970", month = "01"] = monthKey.split("-");
        const firstDay = new Date(Number(year), Number(month) - 1, 1);
        const daysInMonth = new Date(Number(year), Number(month), 0).getDate();
        const eventsByDay = new Map<number, CalendarEvent[]>();
        for (const event of monthEvents) {
          const day = event.date.getDate();
          eventsByDay.set(day, [...(eventsByDay.get(day) ?? []), event]);
        }
        return (
          <section className="mle-fieldnotes-calendar-month" key={monthKey} aria-label={new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(firstDay)}>
            <h3>{new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(firstDay)}</h3>
            <div className="mle-fieldnotes-calendar-grid">
              {weekdays.map((weekday, index) => <span className="mle-fieldnotes-calendar-weekday" key={`${weekday}-${index}`}>{weekday}</span>)}
              {Array.from({ length: firstDay.getDay() }, (_, index) => <span className="mle-fieldnotes-calendar-blank" key={`blank-${index}`} aria-hidden="true" />)}
              {Array.from({ length: daysInMonth }, (_, index) => {
                const day = index + 1;
                const dayEvents = eventsByDay.get(day) ?? [];
                return (
                  <div className="mle-fieldnotes-calendar-day" key={day} data-has-events={dayEvents.length > 0}>
                    <span className="mle-fieldnotes-calendar-day-number">{day}</span>
                    {dayEvents.slice(0, 3).map((event) => <span className="mle-fieldnotes-calendar-event" key={event.note.id} title={event.label}>{event.label}</span>)}
                    {dayEvents.length > 3 && <span className="mle-fieldnotes-calendar-more">+{dayEvents.length - 3} more</span>}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {!months.length && <p>No notes have a usable date in “{fieldLabel(dateField)}”.</p>}
    </div>
  );
}

function sourceDigest(raw: string): Promise<string> {
  if (!globalThis.crypto?.subtle) return Promise.reject(new Error("This browser cannot create a local script trust fingerprint."));
  return globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)).then((buffer) =>
    [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function fieldnotesBlockIndex(editor: NodeViewProps["editor"], getPos: NodeViewProps["getPos"]): number {
  let position: number | undefined;
  try { position = getPos(); } catch { return -1; }
  if (typeof position !== "number") return -1;
  const targetPosition = position;
  let index = 0;
  editor.state.doc.descendants((candidate, candidatePosition) => {
    if (candidate.type.name === "fieldnotesView" && candidatePosition < targetPosition) index += 1;
  });
  return index;
}

const SAFE_VIEW_KEY = /^(?!__proto__$|prototype$|constructor$)[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const CREATE_ACTION_RETRY_WINDOW_MS = 1_500;

type RecentCreateAction = { fingerprint: string; actionId: string; createdAt: number };

function isVisualizationValue(value: unknown, depth = 0): value is VisualizationValue {
  if (depth > 6) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return typeof value !== "string" || value.length <= 4_000;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 50 && value.every((item) => isVisualizationValue(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value);
  return entries.length <= 50 && entries.every(([key, item]) => SAFE_VIEW_KEY.test(key) && isVisualizationValue(item, depth + 1));
}

function recordFromJson(value: string | undefined, label: string): Record<string, VisualizationValue> | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 50) {
    throw new Error(`${label} must be an object with at most 50 fields.`);
  }
  const result: Record<string, VisualizationValue> = {};
  for (const [key, child] of Object.entries(parsed)) {
    if (!SAFE_VIEW_KEY.test(key) || !isVisualizationValue(child)) throw new Error(`${label} contains an unsupported field or value.`);
    result[key] = child;
  }
  return result;
}

function folderIdFromField(fields: Record<string, string>): string | null | undefined {
  if (!Object.hasOwn(fields, "folderId")) return undefined;
  return !fields.folderId || fields.folderId === "root" ? null : fields.folderId;
}

function FieldnotesViewNodeView({ node, editor, getPos, updateAttributes, options }: {
  node: NodeViewProps["node"];
  editor: NodeViewProps["editor"];
  getPos: NodeViewProps["getPos"];
  updateAttributes: NodeViewProps["updateAttributes"];
  options: FieldnotesViewOptions;
}) {
  const raw = typeof node.attrs.raw === "string" ? node.attrs.raw : "";
  const documentId = options.visualizationDocumentId ?? "";
  const blockIndex = fieldnotesBlockIndex(editor, getPos);
  const [editing, setEditing] = useState(false);
  const [sourceDraft, setSourceDraft] = useState(raw);
  const [result, setResult] = useState<VisualizationQueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [fingerprint, setFingerprint] = useState<{ source: string; hash: string } | null>(null);
  const [reviewingSource, setReviewingSource] = useState(false);
  const [trustRevision, setTrustRevision] = useState(0);
  const [viewState, setViewState] = useState<Record<string, VisualizationValue>>({});
  const refreshRef = useRef<(() => void) | null>(null);
  const recentCreateActionRef = useRef<RecentCreateAction | null>(null);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const requestGenerationRef = useRef(0);
  const currentControllerRef = useRef<AbortController | null>(null);
  const sourceHash = fingerprint?.source === raw ? fingerprint.hash : "";
  const parsed = useMemo(() => {
    try { return { config: parseFieldnotesViewConfig(raw), error: "" }; }
    catch (caught) { return { config: null, error: caught instanceof Error ? caught.message : "Invalid visualization source." }; }
  }, [raw]);

  useEffect(() => {
    let active = true;
    setFingerprint(null);
    setReviewingSource(false);
    setActionMessage("");
    setActionError("");
    void sourceDigest(raw).then((hash) => {
      if (active) setFingerprint({ source: raw, hash });
    }).catch((caught: unknown) => {
      if (active) setActionError(caught instanceof Error ? caught.message : "Could not fingerprint this view source.");
    });
    return () => { active = false; };
  }, [raw]);

  useEffect(() => setSourceDraft(raw), [raw]);

  useEffect(() => {
    if (!parsed.config) {
      setError(parsed.error);
      setResult(null);
      return;
    }
    const query = options.queryVisualization;
    if (!query) {
      setError("Vault query is unavailable in this editor.");
      return;
    }
    let disposed = false;
    const load = () => {
      const generation = ++requestGenerationRef.current;
      currentControllerRef.current?.abort();
      const controller = new AbortController();
      currentControllerRef.current = controller;
      setLoading(true);
      setError("");
      void query(parsed.config?.query ?? {}, controller.signal)
        .then((next) => {
          if (!disposed && !controller.signal.aborted && generation === requestGenerationRef.current) setResult(next);
        })
        .catch((caught: unknown) => {
          if (disposed || controller.signal.aborted || generation !== requestGenerationRef.current) return;
          setResult(null);
          setError(caught instanceof Error ? caught.message : "This view could not load notes.");
        })
        .finally(() => {
          if (!disposed && !controller.signal.aborted && generation === requestGenerationRef.current) setLoading(false);
        });
    };
    refreshRef.current = load;
    const scheduleRefresh = () => {
      if (refreshTimerRef.current !== undefined) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(load, 140);
    };
    setResult(null);
    load();
    const unsubscribe = options.subscribeToVaultChanges?.(scheduleRefresh);
    return () => {
      disposed = true;
      requestGenerationRef.current += 1;
      currentControllerRef.current?.abort();
      currentControllerRef.current = null;
      if (refreshTimerRef.current !== undefined) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = undefined;
      if (refreshRef.current === load) refreshRef.current = null;
      unsubscribe?.();
    };
  }, [options.queryVisualization, options.subscribeToVaultChanges, parsed.config, parsed.error]);

  const trusted = Boolean(
    parsed.config?.view === "custom"
    && sourceHash
    && documentId
    && blockIndex >= 0
    && trustRevision >= 0
    && options.visualizationTrustAdapter.isTrusted(documentId, blockIndex, sourceHash),
  );

  async function handleSandboxEvent(event: VisualizationUiEvent): Promise<Record<string, unknown> | void> {
    setActionError("");
    setActionMessage("");
    try {
      return await dispatchSandboxEvent(event);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The requested action failed.";
      const conflict = message.includes("changed since") || message.includes("version_conflict");
      setActionError(conflict
        ? "This note changed elsewhere. The view was refreshed; review it before trying again."
        : message);
      if (conflict) refreshRef.current?.();
      throw caught;
    }
  }

  async function dispatchSandboxEvent(event: VisualizationUiEvent): Promise<Record<string, unknown> | void> {
    if (event.type === "state.set" || event.type === "state.toggle") {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(event.key)) throw new Error("View state keys must be short identifiers.");
      const value = event.type === "state.toggle" ? viewState[event.key] !== true : event.value;
      if (JSON.stringify(value).length > 4_000) throw new Error("A view state value is larger than 4 KB.");
      const next = { ...viewState, [event.key]: value };
      if (Object.keys(next).length > 100 || JSON.stringify(next).length > 20_000) throw new Error("View state is larger than its 20 KB limit.");
      setViewState(next);
      return;
    }
    if (!result) throw new Error("This view is still loading notes.");
    if (event.type === "note.open") {
      if (!result.notes.some((note) => note.id === event.noteId)) throw new Error("This note is not in the current view results.");
      await options.openVisualizationNote(event.noteId);
      return;
    }

    let action: VisualizationAction | undefined;
    let refreshAfter = false;
    if (event.type === "note.create") {
      const title = event.fields.title?.trim();
      if (!title) throw new Error("A title is required to create a note.");
      const frontmatter = recordFromJson(event.fields.frontmatter, "Frontmatter");
      const body = Object.hasOwn(event.fields, "body") ? event.fields.body ?? "" : undefined;
      const folderId = folderIdFromField(event.fields);
      const payload = {
        type: "note.create" as const,
        title,
        ...(body === undefined ? {} : { body }),
        ...(frontmatter ? { frontmatter } : {}),
        ...(folderId === undefined ? {} : { folderId }),
      };
      const fingerprint = JSON.stringify(payload);
      const now = Date.now();
      const recent = recentCreateActionRef.current;
      const actionId = recent && recent.fingerprint === fingerprint && now - recent.createdAt < CREATE_ACTION_RETRY_WINDOW_MS
        ? recent.actionId
        : crypto.randomUUID();
      recentCreateActionRef.current = { fingerprint, actionId, createdAt: now };
      action = {
        ...payload,
        actionId,
      };
      refreshAfter = true;
    } else if (event.type === "note.update" || event.type === "note.frontmatter.patch" || event.type === "note.trash") {
      const note = result.notes.find((candidate) => candidate.id === event.noteId);
      if (!note) throw new Error("This note is not in the current view results. Refresh and try again.");
      if (note.id === documentId) throw new Error("A view cannot modify the note that contains it. Edit that note in the editor.");
      if (event.type === "note.trash") {
        action = { type: "note.trash", id: note.id, expectedVersion: note.version, expectedHash: note.contentHash };
      } else if (event.type === "note.frontmatter.patch") {
        const patch = recordFromJson(event.fields.patch, "Frontmatter patch");
        if (!patch) throw new Error("A JSON frontmatter patch is required.");
        action = { type: "note.frontmatter.patch", id: note.id, expectedVersion: note.version, expectedHash: note.contentHash, patch };
      } else {
        const frontmatterPatch = recordFromJson(event.fields.frontmatterPatch, "Frontmatter patch");
        action = {
          type: "note.update",
          id: note.id,
          expectedVersion: note.version,
          expectedHash: note.contentHash,
          ...(Object.hasOwn(event.fields, "title") ? { title: event.fields.title } : {}),
          ...(Object.hasOwn(event.fields, "body") ? { body: event.fields.body } : {}),
          ...(frontmatterPatch ? { frontmatterPatch } : {}),
          ...(folderIdFromField(event.fields) !== undefined ? { folderId: folderIdFromField(event.fields) } : {}),
        };
      }
      refreshAfter = true;
    } else if (event.type === "trash.restore") {
      const trash = result.trash?.find((candidate) => candidate.id === event.noteId);
      if (!trash) throw new Error("This note is no longer in the current trash view.");
      action = { type: "trash.restore", id: trash.id, expectedVersion: trash.version };
      refreshAfter = true;
    }

    if (!action) throw new Error("This visualization action is not supported.");
    const response = await options.runVisualizationAction(action);
    setActionMessage("Change saved.");
    if (refreshAfter) refreshRef.current?.();
    return response;
  }

  const notes = result?.notes ?? EMPTY_VISUALIZATION_NOTES;
  const trash = result?.trash ?? EMPTY_VISUALIZATION_TRASH;
  return (
    <NodeViewWrapper className="mle-fieldnotes-view-block" contentEditable={false} data-view={parsed.config?.view ?? "invalid"}>
      <div className="mle-fieldnotes-view-heading">
        <strong>Fieldnotes view</strong>
        {parsed.config && <span>{parsed.config.view}{loading ? " · Updating" : result ? ` · ${notes.length} notes` : ""}</span>}
        <button type="button" onClick={() => { setSourceDraft(raw); setEditing((value) => !value); }}>{editing ? "Close source" : "Edit source"}</button>
      </div>
      {editing && (
        <div className="mle-fieldnotes-view-source">
          <label>Visualization block source<textarea value={sourceDraft} maxLength={24_000} rows={8} onChange={(event) => setSourceDraft(event.currentTarget.value)} /></label>
          <div>
            <button type="button" onClick={() => { updateAttributes({ raw: sourceDraft }); setEditing(false); }}>Apply source</button>
            <button type="button" onClick={() => { setSourceDraft(raw); setEditing(false); }}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="mle-fieldnotes-view-message" role="alert">{error}</p>}
      {actionError && <p className="mle-fieldnotes-view-message" role="alert">{actionError}</p>}
      {actionMessage && <p className="mle-fieldnotes-view-message" role="status">{actionMessage}</p>}
      {parsed.config?.view === "table" && !error && <TableVisualization notes={notes} config={parsed.config} />}
      {parsed.config?.view === "calendar" && !error && <CalendarVisualization notes={notes} config={parsed.config} />}
      {parsed.config?.view === "custom" && !options.enableCustomVisualizations && (
        <p className="mle-fieldnotes-view-message">Custom view execution is unavailable in this editor.</p>
      )}
      {parsed.config?.view === "custom" && options.enableCustomVisualizations && !error && !trusted && (
        <div className="mle-fieldnotes-view-trust" role="group" aria-label="Trust custom visualization">
          <p>This JavaScript will receive only the selected note data and view state. Review it before running.</p>
          <p>Approval stays in this browser profile for this note, view position, and exact source. It asks again if one changes, browser data is cleared, or you use another profile or Fieldnotes address.</p>
          {!documentId && <p>Save this note before trusting its script.</p>}
          {!sourceHash && <p>Creating a script fingerprint…</p>}
          <button type="button" disabled={!documentId || !sourceHash} onClick={() => setReviewingSource(true)}>Review script</button>
          {reviewingSource && (
            <div className="mle-fieldnotes-view-review">
              <details open><summary>JavaScript source ({sourceHash.slice(0, 16)})</summary><pre>{parsed.config.js}</pre></details>
              <button type="button" onClick={() => {
                if (!options.visualizationTrustAdapter.trust || blockIndex < 0) {
                  setActionError("This editor cannot store a trust approval.");
                  return;
                }
                try {
                  options.visualizationTrustAdapter.trust(documentId, blockIndex, sourceHash);
                  setTrustRevision((revision) => revision + 1);
                  setReviewingSource(false);
                  setActionMessage("This exact view source is trusted on this device.");
                } catch (caught) { setActionError(caught instanceof Error ? caught.message : "Could not trust this view source."); }
              }}>Trust this source and run</button>
              <button type="button" onClick={() => setReviewingSource(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
      {parsed.config?.view === "custom" && options.enableCustomVisualizations && trusted && !error && result && (
        <div className="mle-fieldnotes-view-approved">
          <div className="mle-fieldnotes-view-trust-status">
            <span>Trusted in this browser profile for this note, view position, and exact source</span>
            <button type="button" onClick={() => {
              try {
                options.visualizationTrustAdapter.revoke?.(documentId, blockIndex, sourceHash);
                setTrustRevision((revision) => revision + 1);
                setActionMessage("Trust was revoked. This script has stopped.");
              } catch (caught) { setActionError(caught instanceof Error ? caught.message : "Could not revoke trust."); }
            }}>Revoke trust</button>
          </div>
          <SandboxedVisualization javascript={parsed.config.js ?? ""} notes={notes} trash={trash} state={viewState} onAction={handleSandboxEvent} />
        </div>
      )}
      {parsed.config?.view === "custom" && options.enableCustomVisualizations && !error && !result && (
        <p className="mle-fieldnotes-view-message" role="status">{loading ? "Loading notes before the custom preview…" : "Waiting for note data…"}</p>
      )}
    </NodeViewWrapper>
  );
}

export const FieldnotesViewBlock = Node.create<FieldnotesViewOptions>({
  name: "fieldnotesView",
  group: "block",
  atom: true,
  selectable: true,
  priority: 200,

  addOptions() {
    return {
      queryVisualization: undefined,
      subscribeToVaultChanges: undefined,
      enableCustomVisualizations: false,
      visualizationDocumentId: undefined,
      visualizationTrustAdapter: { isTrusted: () => false },
      runVisualizationAction: async () => { throw new Error("Fieldnotes actions are unavailable."); },
      openVisualizationNote: async () => { throw new Error("Opening notes is unavailable."); },
    };
  },

  addAttributes() {
    return { raw: { default: "" } };
  },

  parseHTML() {
    return [{ tag: "div[data-fieldnotes-view]", getAttrs: (element) => ({ raw: element.getAttribute("data-raw") ?? "" }) }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-fieldnotes-view": "", "data-raw": node.attrs.raw }];
  },

  markdownTokenName: "code",
  parseMarkdown: (token, helpers) => {
    const language = typeof token.lang === "string" ? token.lang.trim().split(/[ \t]+/u)[0]?.toLowerCase() : "";
    if (token.codeBlockStyle === "indented" || language !== "fieldnotes-view" || typeof token.raw !== "string") return [];
    return helpers.createNode("fieldnotesView", { raw: token.raw });
  },

  renderMarkdown: (node) => typeof node.attrs?.raw === "string" ? node.attrs.raw : "",

  addNodeView() {
    const options = this.options;
    return ReactNodeViewRenderer((props) => <FieldnotesViewNodeView node={props.node} editor={props.editor} getPos={props.getPos} updateAttributes={props.updateAttributes} options={options} />);
  },
});
