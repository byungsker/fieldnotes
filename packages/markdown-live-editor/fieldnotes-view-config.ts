import type { FieldnotesViewConfig } from "./visualization-contract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseFieldnotesViewConfig(raw: string): FieldnotesViewConfig {
  if (raw.length > 24_000) throw new Error("Visualization source is larger than 24 KB.");
  const lines = raw.split(/\r?\n/u);
  const opening = /^ {0,3}(`{3,}|~{3,})fieldnotes-view(?:[ \t].*)?$/u.exec(lines[0] ?? "");
  if (!opening) throw new Error("Use a fenced `fieldnotes-view` block with JSON settings.");
  const marker = (opening[1] ?? "```")[0] ?? "`";
  const markerLength = (opening[1] ?? "```").length;
  const closing = new RegExp(`^ {0,3}${marker}{${markerLength},}[ \\t]*$`, "u");
  if (!closing.test(lines.at(-1) ?? "")) throw new Error("Visualization block needs its closing fence.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines.slice(1, -1).join("\n"));
  } catch {
    throw new Error("Visualization settings must be valid JSON.");
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !["table", "calendar", "custom"].includes(String(parsed.view))) {
    throw new Error("Use version 1 and choose table, calendar, or custom.");
  }
  if (parsed.query !== undefined && !isRecord(parsed.query)) throw new Error("query must be an object.");
  if (parsed.view === "custom" && (typeof parsed.js !== "string" || parsed.js.length === 0 || parsed.js.length > 16_000)) {
    throw new Error("Custom view JavaScript must be between 1 and 16 KB.");
  }
  if (parsed.columns !== undefined && (!Array.isArray(parsed.columns) || parsed.columns.length > 8
    || !parsed.columns.every((column) => typeof column === "string" && /^(?:title|path|createdAt|updatedAt|excerpt|frontmatter\.[A-Za-z0-9_.-]{1,120})$/.test(column)))) {
    throw new Error("columns must list up to 8 supported note fields.");
  }
  if (parsed.dateField !== undefined && (typeof parsed.dateField !== "string" || !/^(?:title|path|createdAt|updatedAt|excerpt|frontmatter\.[A-Za-z0-9_.-]{1,120})$/.test(parsed.dateField))) {
    throw new Error("dateField must use a supported note field.");
  }
  if (parsed.labelField !== undefined && (typeof parsed.labelField !== "string" || !/^(?:title|path|createdAt|updatedAt|excerpt|frontmatter\.[A-Za-z0-9_.-]{1,120})$/.test(parsed.labelField))) {
    throw new Error("labelField must use a supported note field.");
  }
  return parsed as FieldnotesViewConfig;
}

export { parseFieldnotesViewConfig };
