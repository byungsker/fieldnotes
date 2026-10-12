import { useEffect, useMemo, useRef, useState } from "react";
import { Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import type { FieldnotesViewConfig, VisualizationNote, VisualizationQueryResponse, VisualizationValue } from "../../shared/visualization.ts";
import { parseFieldnotesViewConfig } from "./fieldnotes-view-config.ts";
import { SandboxedVisualization } from "./SandboxedVisualization.tsx";
import type { MarkdownLiveEditorAdapters } from "./types.ts";

type FieldnotesViewOptions = Pick<MarkdownLiveEditorAdapters,
  "queryVisualization" | "subscribeToVaultChanges" | "enableCustomVisualizations">;

function valueAt(note: VisualizationNote, field: string): VisualizationValue | undefined {
  if (field === "title" || field === "path" || field === "createdAt" || field === "updatedAt" || field === "excerpt") return note[field];
  if (!field.startsWith("frontmatter.")) return undefined;
  let value: VisualizationValue | undefined = note.frontmatter;
  for (const key of field.slice("frontmatter.".length).split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = value[key];
  }
  return value;
}

function displayValue(value: VisualizationValue | undefined): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return value;
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
    <div className="mle-fieldnotes-table-scroll">
      <table className="mle-fieldnotes-table">
        <thead><tr>{columns.map((field) => <th scope="col" key={field}>{fieldLabel(field)}</th>)}</tr></thead>
        <tbody>
          {notes.map((note) => (
            <tr key={note.id}>
              {columns.map((field) => <td key={field} data-label={fieldLabel(field)}>{displayValue(valueAt(note, field))}</td>)}
            </tr>
          ))}
          {!notes.length && <tr><td colSpan={columns.length}>No notes match this view.</td></tr>}
        </tbody>
      </table>
    </div>
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

function FieldnotesViewNodeView({ node, updateAttributes, options }: {
  node: NodeViewProps["node"];
  updateAttributes: NodeViewProps["updateAttributes"];
  options: FieldnotesViewOptions;
}) {
  const raw = typeof node.attrs.raw === "string" ? node.attrs.raw : "";
  const [editing, setEditing] = useState(false);
  const [sourceDraft, setSourceDraft] = useState(raw);
  const [result, setResult] = useState<VisualizationQueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const requestGenerationRef = useRef(0);
  const currentControllerRef = useRef<AbortController | null>(null);
  const parsed = useMemo(() => {
    try { return { config: parseFieldnotesViewConfig(raw), error: "" }; }
    catch (caught) { return { config: null, error: caught instanceof Error ? caught.message : "Invalid visualization source." }; }
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
      unsubscribe?.();
    };
  }, [options.queryVisualization, options.subscribeToVaultChanges, parsed.config, parsed.error]);

  const notes = result?.notes ?? [];
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
      {parsed.config?.view === "table" && !error && <TableVisualization notes={notes} config={parsed.config} />}
      {parsed.config?.view === "calendar" && !error && <CalendarVisualization notes={notes} config={parsed.config} />}
      {parsed.config?.view === "custom" && !options.enableCustomVisualizations && (
        <p className="mle-fieldnotes-view-message">Custom JavaScript runs only in local development and is disabled in production.</p>
      )}
      {parsed.config?.view === "custom" && options.enableCustomVisualizations && !error && result && (
        <SandboxedVisualization javascript={parsed.config.js ?? ""} notes={notes} />
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
    return { queryVisualization: undefined, subscribeToVaultChanges: undefined, enableCustomVisualizations: false };
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
    return ReactNodeViewRenderer((props) => <FieldnotesViewNodeView node={props.node} updateAttributes={props.updateAttributes} options={options} />);
  },
});
