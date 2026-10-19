import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type {
  VisualizationFilter,
  VisualizationNote,
  VisualizationQuery,
  VisualizationQueryResponse,
  VisualizationTrashNote,
  VisualizationValue,
} from "../../shared/visualization.js";
import { getDocument, getLatestChangeSequence } from "../storage/database.js";
import type { DocumentRecord } from "../storage/types.js";
import { parseFrontmatter } from "./frontmatter.js";
import { extractLocalImageReferences } from "./assets.js";
import { MAX_VIEW_TRASH_CANDIDATES } from "../view-query-limits.js";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SCAN_NOTES = 1_000;
const MAX_SCAN_BYTES = 20_000_000;
const MAX_RESULT_BYTES = 1_500_000;
const FIELD_PATTERN = /^(?:title|path|createdAt|updatedAt|excerpt|frontmatter\.[A-Za-z0-9_.-]{1,120})$/;
const ALLOWED_QUERY_KEYS = new Set(["folderId", "search", "where", "sort", "limit", "includeTrash"]);

export class VisualizationQueryError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "VisualizationQueryError";
    this.status = status;
  }
}

const PATH_FILTER_SQL_FUNCTION = "fieldnotes_view_path_matches";
const registeredPathFilterDatabases = new WeakSet<DatabaseSync>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isVisualizationValue(value: unknown, depth = 0): value is VisualizationValue {
  if (depth > 6) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 50 && value.every((item) => isVisualizationValue(item, depth + 1));
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 50 && entries.every(([key, item]) => key.length <= 120 && isVisualizationValue(item, depth + 1));
}

function validateFilter(value: unknown, index: number): VisualizationFilter {
  if (!isRecord(value) || typeof value.field !== "string" || !FIELD_PATTERN.test(value.field)) {
    throw new VisualizationQueryError(`Filter ${index + 1} must use a supported note or frontmatter field.`);
  }
  const operators = ["eq", "contains", "exists", "before", "after", "in"] as const;
  if (typeof value.operator !== "string" || !operators.includes(value.operator as typeof operators[number])) {
    throw new VisualizationQueryError(`Filter ${index + 1} uses an unsupported operator.`);
  }
  if (value.operator === "exists") return { field: value.field, operator: "exists" };
  if (!Object.hasOwn(value, "value") || !isVisualizationValue(value.value)) {
    throw new VisualizationQueryError(`Filter ${index + 1} needs a small scalar, array, or object value.`);
  }
  if (JSON.stringify(value.value).length > 1_000) {
    throw new VisualizationQueryError(`Filter ${index + 1} value is too large.`);
  }
  if (value.operator === "in" && (!Array.isArray(value.value) || value.value.length > 20)) {
    throw new VisualizationQueryError(`Filter ${index + 1} “in” value must be an array of at most 20 items.`);
  }
  return { field: value.field, operator: value.operator as VisualizationFilter["operator"], value: value.value };
}

export function validateVisualizationQuery(value: unknown): VisualizationQuery {
  if (!isRecord(value)) throw new VisualizationQueryError("query must be an object.");
  if (Object.keys(value).some((key) => !ALLOWED_QUERY_KEYS.has(key))) {
    throw new VisualizationQueryError("query contains an unsupported option.");
  }
  const query: VisualizationQuery = {};
  if (Object.hasOwn(value, "folderId")) {
    if (value.folderId !== null && (typeof value.folderId !== "string" || !ID_PATTERN.test(value.folderId))) {
      throw new VisualizationQueryError("folderId must be a folder UUID or null.");
    }
    query.folderId = value.folderId as string | null;
  }
  if (Object.hasOwn(value, "search")) {
    if (typeof value.search !== "string" || value.search.length > 120) {
      throw new VisualizationQueryError("search must be 120 characters or fewer.");
    }
    query.search = value.search.trim();
  }
  if (Object.hasOwn(value, "where")) {
    if (!Array.isArray(value.where) || value.where.length > 8) {
      throw new VisualizationQueryError("where must contain at most 8 filters.");
    }
    query.where = value.where.map(validateFilter);
  }
  if (Object.hasOwn(value, "sort")) {
    if (!isRecord(value.sort) || typeof value.sort.field !== "string" || !FIELD_PATTERN.test(value.sort.field)
      || (value.sort.direction !== "asc" && value.sort.direction !== "desc")) {
      throw new VisualizationQueryError("sort must name a supported field and use asc or desc.");
    }
    query.sort = { field: value.sort.field, direction: value.sort.direction };
  }
  if (Object.hasOwn(value, "limit")) {
    if (!Number.isInteger(value.limit) || Number(value.limit) < 1) {
      throw new VisualizationQueryError("limit must be a positive integer.");
    }
    query.limit = Math.min(Number(value.limit), 200);
  }
  if (Object.hasOwn(value, "includeTrash")) {
    if (typeof value.includeTrash !== "boolean") throw new VisualizationQueryError("includeTrash must be true or false.");
    query.includeTrash = value.includeTrash;
  }
  return query;
}

function fieldValue(note: VisualizationNote, field: string): VisualizationValue | undefined {
  if (field === "title") return note.title;
  if (field === "path") return note.path;
  if (field === "createdAt") return note.createdAt;
  if (field === "updatedAt") return note.updatedAt;
  if (field === "excerpt") return note.excerpt;
  if (!field.startsWith("frontmatter.")) return undefined;
  let value: VisualizationValue | undefined = note.frontmatter;
  for (const key of field.slice("frontmatter.".length).split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    if (!Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function comparable(value: VisualizationValue | undefined): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") return JSON.stringify(value).toLocaleLowerCase();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && /^\d{4}-\d{2}-\d{2}(?:[Tt\s]|$)/.test(value) ? timestamp : value.toLocaleLowerCase();
}

function equals(left: VisualizationValue | undefined, right: VisualizationValue): boolean {
  if (left === undefined) return false;
  if (typeof left === "string" && typeof right === "string") return left.toLocaleLowerCase() === right.toLocaleLowerCase();
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesFilter(note: VisualizationNote, filter: VisualizationFilter): boolean {
  const actual = fieldValue(note, filter.field);
  if (filter.operator === "exists") return actual !== undefined;
  const expected = filter.value;
  if (expected === undefined || actual === undefined) return false;
  if (filter.operator === "eq") return equals(actual, expected);
  if (filter.operator === "in") return Array.isArray(expected) && expected.some((item) => equals(actual, item));
  if (filter.operator === "contains") {
    if (typeof actual === "string") return typeof expected === "string" && actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
    if (Array.isArray(actual)) return actual.some((item) => equals(item, expected));
    return false;
  }
  const actualComparable = comparable(actual);
  const expectedComparable = comparable(expected);
  if (actualComparable === null || expectedComparable === null || typeof actualComparable !== typeof expectedComparable) return false;
  return filter.operator === "before" ? actualComparable < expectedComparable : actualComparable > expectedComparable;
}

function registerPathFilterSqlFunction(db: DatabaseSync): void {
  if (registeredPathFilterDatabases.has(db)) return;
  db.function(PATH_FILTER_SQL_FUNCTION, { deterministic: true, directOnly: true }, (filePath, serializedFilter) => {
    if (typeof serializedFilter !== "string") return 0;
    const filter = JSON.parse(serializedFilter) as VisualizationFilter;
    const note = {
      id: "",
      title: "",
      path: typeof filePath === "string" ? filePath : "",
      createdAt: "",
      updatedAt: "",
      version: 1,
      contentHash: "",
      excerpt: "",
      frontmatter: {},
    } satisfies VisualizationNote;
    return Number(matchesFilter(note, filter));
  });
  registeredPathFilterDatabases.add(db);
}

function sortNotes(notes: VisualizationNote[], query: VisualizationQuery): void {
  if (!query.sort) return;
  const direction = query.sort.direction === "asc" ? 1 : -1;
  notes.sort((left, right) => {
    const a = comparable(fieldValue(left, query.sort!.field));
    const b = comparable(fieldValue(right, query.sort!.field));
    if (a === null) return b === null ? left.title.localeCompare(right.title) : 1;
    if (b === null) return -1;
    if (typeof a === "number" && typeof b === "number") return direction * (a - b);
    return direction * String(a).localeCompare(String(b), undefined, { numeric: true });
  });
}

export function queryVisualizationNotes(
  db: DatabaseSync,
  query: VisualizationQuery,
  trashNotes: VisualizationTrashNote[] = [],
  readDocument: (id: string) => DocumentRecord | undefined = (id) => getDocument(db, id),
): VisualizationQueryResponse {
  const clauses: string[] = [];
  const parameters: (string | number)[] = [];
  if (query.folderId !== undefined) {
    clauses.push(query.folderId === null ? "folder_id IS NULL" : "folder_id = ?");
    if (query.folderId !== null) parameters.push(query.folderId);
  }
  const pathFilters = query.where?.filter((filter) => filter.field === "path") ?? [];
  if (pathFilters.length) {
    registerPathFilterSqlFunction(db);
    for (const filter of pathFilters) {
      clauses.push(`${PATH_FILTER_SQL_FUNCTION}(file_path, ?) = 1`);
      parameters.push(JSON.stringify(filter));
    }
  }
  const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  parameters.push(MAX_SCAN_NOTES + 1);
  const candidates = db.prepare(
    `SELECT id FROM documents ${whereClause} ORDER BY updated_at DESC, title COLLATE NOCASE ASC LIMIT ?`,
  ).all(...parameters) as Array<{ id: string }>;
  if (candidates.length > MAX_SCAN_NOTES) {
    throw new VisualizationQueryError("This view would scan too many notes. Choose a folder to narrow it.", 413);
  }

  let scannedBytes = 0;
  const notes: VisualizationNote[] = [];
  for (const candidate of candidates) {
    const document = readDocument(candidate.id);
    if (!document) continue;
    scannedBytes += Buffer.byteLength(document.body, "utf8");
    if (scannedBytes > MAX_SCAN_BYTES) {
      throw new VisualizationQueryError("This view would read too much note text. Choose a folder to narrow it.", 413);
    }
    const parsed = parseFrontmatter(document.body);
    const assetPaths = document.filePath ? extractLocalImageReferences(document.body, document.filePath) : [];
    const note: VisualizationNote = {
      id: document.id,
      title: document.title,
      path: document.filePath ?? "",
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      version: document.version,
      contentHash: document.contentHash ?? createHash("sha256").update(document.body, "utf8").digest("hex"),
      excerpt: document.excerpt,
      frontmatter: parsed.values,
      ...(assetPaths.length ? { assetPaths } : {}),
      ...(parsed.error ? { frontmatterError: parsed.error } : {}),
    };
    if (query.where?.some((filter) => !matchesFilter(note, filter))) continue;
    if (query.search) {
      const haystack = `${note.title}\n${note.path}\n${note.excerpt}\n${JSON.stringify(note.frontmatter)}`.toLocaleLowerCase();
      if (!haystack.includes(query.search.toLocaleLowerCase())) continue;
    }
    notes.push(note);
  }

  sortNotes(notes, query);
  const limited = notes.slice(0, query.limit ?? 100);
  const trash = query.includeTrash
    ? trashNotes
      .filter((note) => !query.search || `${note.title}\n${note.excerpt}`.toLocaleLowerCase().includes(query.search.toLocaleLowerCase()))
      .slice(0, Math.min(query.limit ?? 100, MAX_VIEW_TRASH_CANDIDATES))
    : undefined;
  const response: VisualizationQueryResponse = {
    notes: limited,
    ...(trash ? { trash } : {}),
    sequence: getLatestChangeSequence(db),
  };
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_RESULT_BYTES) {
    throw new VisualizationQueryError("The view result is too large. Reduce its limit or choose a narrower folder.", 413);
  }
  return response;
}
