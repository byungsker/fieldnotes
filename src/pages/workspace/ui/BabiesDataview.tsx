import React, { useContext, useEffect, useState } from "react";
import type { MarkdownPreviewContext, PreviewDocument } from "../../../../packages/markdown-live-editor";
import type { BabiesPreviewAdapters } from "../model/baby-preview";
import { BabiesPreviewDocumentsContext } from "./BabiesPreviewContext.ts";

import {
  parseSafeBabyFrontmatter,
  scalarText,
  detectView,
  localDate,
  classifyChild,
  readBabySourceSettings,
  ageForSource,
  openOrCreateDailyRecord,
  recordsFromDocuments,
  firstLocalImageReference,
  pngFallbackReference,
  displayDate,
  openDocument,
  minutesFromValue,
  formatDuration,
  type YamlValue,
  type RecordData,
} from "../model/baby-records";

void React;

function LoadingNotice({ error, loading }: { error: boolean; loading: boolean }) {
  if (loading) return <p className="babies-view-status" role="status">Loading baby records…</p>;
  if (error) return <p className="babies-view-status" role="alert">Baby note data could not be loaded.</p>;
  return null;
}

function BabyDashboard({ records, context, adapters, source }: { records: RecordData[]; context: MarkdownPreviewContext; adapters?: BabiesPreviewAdapters; source: string }) {
  const latest = records[0];
  const today = new Date();
  const todayText = localDate(today);
  const settings = readBabySourceSettings(source);
  const age = ageForSource(records, todayText, source);
  const heroPhoto = settings.photoPath && context.documentId
    ? adapters?.resolveVaultAsset?.(context.documentId, settings.photoPath)
    : undefined;
  const heroPngPath = settings.photoPath ? pngFallbackReference(settings.photoPath) : null;
  const heroPngFallback = heroPngPath && context.documentId
    ? adapters?.resolveVaultAsset?.(context.documentId, heroPngPath)
    : undefined;
  const [viewMonth, setViewMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [useHeroPngFallback, setUseHeroPngFallback] = useState(false);
  const [creatingDate, setCreatingDate] = useState("");
  const [createError, setCreateError] = useState("");
  const [showAllMilestones, setShowAllMilestones] = useState(false);
  const [showAllRecords, setShowAllRecords] = useState(false);
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(viewMonth);
  const recordsByDate = new Map(records.map((record) => [record.date, record]));
  const milestones = records.flatMap((record) => record.milestones.map((item) => ({ ...item, date: record.date, documentId: record.document.id })));
  const allGoals = [...new Set(records.flatMap((record) => record.goals))];
  const thisMonthCount = records.filter((record) => record.date.startsWith(todayText.slice(0, 7))).length;
  const createForDate = async (date: string) => {
    setCreatingDate(date);
    setCreateError("");
    try {
      await openOrCreateDailyRecord(date, records, context, adapters, source);
    } catch {
      setCreateError("The daily record could not be opened or created.");
    } finally {
      setCreatingDate("");
    }
  };
  const previousMonth = () => setViewMonth((value) => new Date(value.getFullYear(), value.getMonth() - 1, 1));
  const nextMonth = () => setViewMonth((value) => new Date(value.getFullYear(), value.getMonth() + 1, 1));
  const currentMonth = () => setViewMonth(new Date(today.getFullYear(), today.getMonth(), 1));
  const visibleMilestones = showAllMilestones ? milestones : milestones.slice(0, 5);
  const visibleRecords = showAllRecords ? records : records.slice(0, 5);
  return (
    <section className="babies-view babies-dashboard" aria-label="Baby dashboard">
      <div className="babies-view-heading"><div><span className="babies-view-eyebrow">FIELDNOTES</span><h2>{settings.dashboardTitle || "Baby dashboard"}</h2></div><span className="babies-view-count">{records.length} records</span></div>
      {heroPhoto && <img className="babies-view-hero-photo" src={useHeroPngFallback && heroPngFallback ? heroPngFallback : heroPhoto} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => {
        if (heroPngFallback && !useHeroPngFallback) setUseHeroPngFallback(true);
      }} />}
      <div className="babies-view-cards">
        <article className="babies-view-card"><span>Age</span><strong>{age?.text || latest?.ageText || "—"}</strong>{age && <small>{age.totalDays.toLocaleString()} days</small>}</article>
        <article className="babies-view-card"><span>Milestones</span><strong>{milestones.length}</strong><small>recorded moments</small></article>
        <article className="babies-view-card"><span>This month</span><strong>{thisMonthCount}</strong><small>daily records</small></article>
        <article className="babies-view-card"><span>Age in months</span><strong>{age?.months ?? "—"}</strong><small>completed months</small></article>
      </div>
      {latest?.highlight && <article className="babies-view-highlight"><span>RECENT HIGHLIGHT</span><p>{latest.highlight}</p><button type="button" onClick={() => openDocument(context, latest.document.id)}>Open record</button></article>}
      <section className="babies-view-panel">
        <div className="babies-view-panel-heading"><h3>Calendar</h3><div className="babies-calendar-controls">
          <button type="button" aria-label="Previous month" onClick={previousMonth}>‹</button>
          <strong>{monthLabel}</strong>
          <button type="button" aria-label="Next month" onClick={nextMonth}>›</button>
          <button type="button" onClick={currentMonth}>Today</button>
        </div></div>
        <div className="babies-calendar" role="grid" aria-label={monthLabel}>
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day} className="babies-calendar-weekday" role="columnheader">{day}</span>)}
          {Array.from({ length: firstWeekday }, (_, index) => <span key={"empty-" + index} className="babies-calendar-empty" aria-hidden="true" />)}
          {Array.from({ length: daysInMonth }, (_, index) => {
            const day = index + 1;
            const date = year + "-" + String(month + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
            const record = recordsByDate.get(date);
            const photoReference = record ? firstLocalImageReference(record.document.body ?? "") : null;
            const photo = record && photoReference
              ? adapters?.resolveVaultAsset?.(record.document.id, photoReference)
              : undefined;
            const classes = "babies-calendar-day" + (record ? " has-record" : "") + (date === todayText ? " is-today" : "") + (photo ? " has-photo" : "");
            return <button key={date} type="button" className={classes} role="gridcell" aria-label={date + (record ? photo ? ", open record with photo" : ", open record" : ", create record")} disabled={creatingDate === date} onClick={() => {
              if (record) openDocument(context, record.document.id);
              else void createForDate(date);
            }}><span className="babies-calendar-day-number">{day}</span>{photo && <img className="babies-calendar-photo" src={photo} alt="" loading="lazy" referrerPolicy="no-referrer" />}{record && <i />}</button>;
          })}
        </div>
        {createError && <p role="alert">{createError}</p>}
      </section>
      {milestones.length > 0 && <section className="babies-view-panel"><div className="babies-view-panel-heading"><h3>Milestones</h3><span>{milestones.length}</span></div><ul className="babies-view-list">{visibleMilestones.map((item, index) => <li key={item.date + "-" + item.text + "-" + index}><time>{displayDate(item.date)}</time><span>{item.child && <small className="babies-child-badge" data-child-kind={classifyChild(item.child, settings) ?? "other"}>{item.child}</small>}{item.text}</span><button type="button" onClick={() => openDocument(context, item.documentId)}>Open</button></li>)}</ul>{milestones.length > 5 && <button type="button" aria-expanded={showAllMilestones} onClick={() => setShowAllMilestones((value) => !value)}>{showAllMilestones ? "Collapse" : "Show all milestones"}</button>}</section>}
      {allGoals.length > 0 && <section className="babies-view-panel"><div className="babies-view-panel-heading"><h3>Goals</h3></div><ul className="babies-view-goals">{allGoals.map((goal) => <li key={goal}>{goal}</li>)}</ul></section>}
      <section className="babies-view-panel"><div className="babies-view-panel-heading"><h3>Recent records</h3><span>{records.length}</span></div><ul className="babies-view-list">{visibleRecords.map((record) => <li key={record.document.id}><time>{displayDate(record.date)}</time><span>{record.highlight || record.document.title}{record.ageText && <small>{record.ageText}</small>}{record.milestones.length > 0 && <small>🌟 {record.milestones.slice(0, 2).map((item) => item.text).join(" · ")}{record.milestones.length > 2 ? " plus " + (record.milestones.length - 2) + " more" : ""}</small>}</span><button type="button" onClick={() => openDocument(context, record.document.id)}>Open</button></li>)}</ul>{records.length > 5 && <button type="button" aria-expanded={showAllRecords} onClick={() => setShowAllRecords((value) => !value)}>{showAllRecords ? "Collapse" : "Show all records"}</button>}</section>
    </section>
  );
}

function NewEntryView({ records, context, adapters, source }: { records: RecordData[]; context: MarkdownPreviewContext; adapters?: BabiesPreviewAdapters; source: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const today = localDate(new Date());
  const existing = records.find((record) => record.date === today);
  const createOrOpen = async () => {
    setBusy(true);
    setError("");
    try {
      await openOrCreateDailyRecord(today, records, context, adapters, source);
    } catch {
      setError("The daily record could not be opened or created.");
    } finally {
      setBusy(false);
    }
  };
  return <section className="babies-view babies-action-view"><span className="babies-view-eyebrow">DAILY NOTES</span><h2>Today’s diary</h2><p>{existing ? "A record already exists for today." : "Create a daily record in the records folder."}</p><button type="button" disabled={busy} onClick={() => void createOrOpen()}>{busy ? "Opening…" : existing ? "Open today’s record" : "Write today’s record"}</button>{error && <p role="alert">{error}</p>}</section>;
}

const SCHEDULE_TYPES: Record<string, { label: string; emoji: string; background: string; text: string }> = {
  dad: { label: "Dad time", emoji: "🌅", background: "var(--ds-color-info-soft)", text: "var(--ds-color-info)" },
  wake: { label: "Wake", emoji: "☀️", background: "var(--ds-color-warning-soft)", text: "var(--ds-color-warning)" },
  food: { label: "Food", emoji: "🥣", background: "var(--ds-color-success-soft)", text: "var(--ds-color-success)" },
  milk: { label: "Milk", emoji: "🍼", background: "var(--ds-color-rose-soft)", text: "var(--ds-color-rose)" },
  play: { label: "Play", emoji: "🎮", background: "var(--ds-color-violet-soft)", text: "var(--ds-color-violet)" },
  sleep: { label: "Nap", emoji: "😴", background: "var(--ds-color-info-soft)", text: "var(--ds-color-info)" },
  bath: { label: "Bath", emoji: "🛁", background: "var(--ds-color-warning-soft)", text: "var(--ds-color-warning)" },
  night: { label: "Night sleep", emoji: "🌙", background: "var(--ds-color-violet-soft)", text: "var(--ds-color-violet)" },
};

function ScheduleView({ documents, source }: { documents: PreviewDocument[]; source: string }) {
  const advice = readBabySourceSettings(source).scheduleAdvice;
  const scheduleDocument = documents
    .filter((document) => document.filePath?.startsWith("babies/schedule/"))
    .sort((left, right) => (right.filePath?.split("/").at(-1) ?? "").localeCompare(left.filePath?.split("/").at(-1) ?? ""))[0];
  const frontmatter = parseSafeBabyFrontmatter(scheduleDocument?.body ?? "");
  const rules = frontmatter.rules && typeof frontmatter.rules === "object" && !Array.isArray(frontmatter.rules)
    ? Object.entries(frontmatter.rules)
    : [];
  const schedule = Array.isArray(frontmatter.schedule) ? frontmatter.schedule : [];
  const legendTypes = ["dad", "sleep", "milk", "food", "play", "bath", "night"];
  return (
    <section className="babies-view babies-schedule-view" aria-label="Sleep schedule">
      <div className="babies-view-heading"><div><span className="babies-view-eyebrow">ROUTINE</span><h2>Sleep schedule</h2></div><span className="babies-view-count">{scalarText(frontmatter.stage) || scheduleDocument?.filePath?.split("/").at(-1) || ""}</span></div>
      {scalarText(frontmatter.updated) && <p className="babies-view-meta">Updated {scalarText(frontmatter.updated)}</p>}
      {rules.length > 0 && <dl className="babies-view-rules">{rules.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{scalarText(value)}</dd></div>)}</dl>}
      {advice && <aside className="babies-schedule-advice" aria-label="Care notes">{advice}</aside>}
      <div className="babies-schedule-legend" aria-label="Schedule types">{legendTypes.map((type) => {
        const style = SCHEDULE_TYPES[type];
        return <span key={type} style={{ backgroundColor: style.background, color: style.text }}>{style.label}</span>;
      })}</div>
      {schedule.length > 0 ? <div className="babies-schedule-list">{schedule.map((entry, index) => {
        const row = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, YamlValue> : {};
        const type = scalarText(row.type) || "play";
        const style = SCHEDULE_TYPES[type] ?? { label: type, emoji: "", background: "var(--ds-color-violet-soft)", text: "var(--ds-color-violet)" };
        const duration = minutesFromValue(row.duration);
        return <article key={scalarText(row.time) + "-" + index}><time>{scalarText(row.time)}</time><div className="babies-schedule-bar" style={{ minHeight: `max(${duration * 0.38}px, var(--ds-space-7))`, backgroundColor: style.background, color: style.text }}><strong>{style.emoji} {scalarText(row.label)}</strong>{duration >= 60 && <span>{formatDuration(duration)}</span>}</div></article>;
      })}</div> : <p className="babies-view-status">No schedule entries are available.</p>}
    </section>
  );
}

function MilestonesView({ records, context, source }: { records: RecordData[]; context: MarkdownPreviewContext; source: string }) {
  const settings = readBabySourceSettings(source);
  const entries = records.flatMap((record) => record.milestones.map((item) => ({ ...item, date: record.date, documentId: record.document.id })));
  const childLabels = [...new Set(entries.map((entry) => entry.child).filter(Boolean))];
  const childAliases = new Map(childLabels.map((child) => [
    child,
    childLabels
      .filter((candidate) => candidate !== child && candidate.includes(child))
      .sort((left, right) => [...right].length - [...left].length)[0] ?? child,
  ]));
  const normalizedEntries = entries.map((entry) => ({ ...entry, child: childAliases.get(entry.child) ?? entry.child }));
  const childCounts = new Map<string, number>();
  for (const entry of normalizedEntries) if (entry.child) childCounts.set(entry.child, (childCounts.get(entry.child) ?? 0) + 1);
  const children = [...childCounts.keys()].filter(Boolean).sort((left, right) => left.localeCompare(right));
  const categoryCounts: Record<"girl" | "boy", number> = { girl: 0, boy: 0 };
  for (const entry of normalizedEntries) {
    const kind = classifyChild(entry.child, settings);
    if (kind) categoryCounts[kind] += 1;
  }
  const categoryCards = [
    { kind: "girl", label: settings.girlLabel, count: categoryCounts.girl },
    { kind: "boy", label: settings.boyLabel, count: categoryCounts.boy },
  ].filter((item) => item.label && item.count > 0);
  const otherChildren = children.filter((child) => !classifyChild(child, settings));
  const [filter, setFilter] = useState("all");
  const visible = normalizedEntries.filter((item) => filter === "all" || item.child === filter).sort((left, right) => right.date.localeCompare(left.date));
  const grouped = new Map<string, typeof visible>();
  for (const item of visible) {
    const month = item.date.slice(0, 7);
    grouped.set(month, [...(grouped.get(month) ?? []), item]);
  }
  return (
    <section className="babies-view babies-milestones-view" aria-label="Milestone timeline">
      <div className="babies-view-heading"><div><span className="babies-view-eyebrow">GROWTH</span><h2>Milestones</h2></div><span className="babies-view-count">{visible.length}</span></div>
      <div className="babies-view-cards babies-view-child-stats"><article className="babies-view-card"><span>All</span><strong>{entries.length}</strong></article>{categoryCards.map((item) => <article className="babies-view-card" data-child-kind={item.kind} key={item.kind}><span>{item.label}</span><strong>{item.count}</strong></article>)}{otherChildren.map((child) => <article className="babies-view-card" data-child-kind="other" key={child}><span>{child}</span><strong>{childCounts.get(child)}</strong></article>)}</div>
      <label className="babies-view-filter">Show <select aria-label="Filter milestones by child" value={filter} onChange={(event) => setFilter(event.currentTarget.value)}><option value="all">All children</option>{children.map((child) => <option key={child} value={child}>{child}</option>)}</select></label>
      {grouped.size ? [...grouped.entries()].map(([month, items]) => <section className="babies-view-panel" key={month}><div className="babies-view-panel-heading"><h3>{new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(Date.parse(`${month}-15T12:00:00`))}</h3><span>{items.length}</span></div><ul className="babies-view-list">{items.map((item, index) => <li key={`${month}-${item.text}-${index}`}><time>{displayDate(item.date)}</time><span>{item.child && <small className="babies-child-badge" data-child-kind={classifyChild(item.child, settings) ?? "other"}>{item.child}</small>}{item.text}</span><button type="button" onClick={() => openDocument(context, item.documentId)}>Open</button></li>)}</ul></section>) : <p className="babies-view-status">No milestones are available for this filter.</p>}
    </section>
  );
}

export function BabiesDataview({ source, context, adapters }: { source: string; context: MarkdownPreviewContext; adapters?: BabiesPreviewAdapters }) {
  const state = useContext(BabiesPreviewDocumentsContext);
  const kind = detectView(source, context);
  if (!kind) return <p className="babies-view-status">DataviewJS is preserved as source and is not executed.</p>;
  const records = recordsFromDocuments(state.documents);
  if (kind === "new-entry") return <NewEntryView records={records} context={context} adapters={adapters} source={source} />;
  if (kind === "schedule") {
    return <><LoadingNotice error={state.error} loading={state.loading} /><ScheduleView documents={state.documents} source={source} /></>;
  }
  if (kind === "milestones") {
    return <><LoadingNotice error={state.error} loading={state.loading} /><MilestonesView records={records} context={context} source={source} /></>;
  }
  return <><LoadingNotice error={state.error} loading={state.loading} /><BabyDashboard records={records} context={context} adapters={adapters} source={source} /></>;
}

/** Load only local baby notes through the host's bounded API adapter. */
export function BabiesDataviewPreview({ source, context, adapters }: { source: string; context: MarkdownPreviewContext; adapters?: BabiesPreviewAdapters }) {
  const [state, setState] = useState({ documents: [] as PreviewDocument[], loading: true, error: false });

  useEffect(() => {
    const load = adapters?.loadBabyPreviewDocuments;
    if (!load) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 어댑터가 사라지면 기존 문서와 로딩 상태를 즉시 비운다.
      setState({ documents: [], loading: false, error: true });
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: false }));
    void load(controller.signal).then((documents) => {
      if (!controller.signal.aborted) setState({ documents, loading: false, error: false });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ documents: [], loading: false, error: true });
    });
    return () => controller.abort();
  }, [adapters?.loadBabyPreviewDocuments]);

  return (
    <BabiesPreviewDocumentsContext.Provider value={state}>
      <BabiesDataview source={source} context={context} adapters={adapters} />
    </BabiesPreviewDocumentsContext.Provider>
  );
}
