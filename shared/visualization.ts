export type VisualizationScalar = string | number | boolean | null;
export type VisualizationValue = VisualizationScalar | VisualizationValue[] | { [key: string]: VisualizationValue };

export type VisualizationFilter = {
  field: string;
  operator: "eq" | "contains" | "exists" | "before" | "after" | "in";
  value?: VisualizationValue;
};

export type VisualizationQuery = {
  folderId?: string | null;
  search?: string;
  where?: VisualizationFilter[];
  sort?: { field: string; direction: "asc" | "desc" };
  limit?: number;
  includeTrash?: boolean;
};

export type VisualizationNote = {
  id: string;
  title: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  contentHash: string;
  excerpt: string;
  frontmatter: Record<string, VisualizationValue>;
  /** Safe relative raster images explicitly embedded by this note, if any. */
  assetPaths?: string[];
  frontmatterError?: string;
};

export type VisualizationTrashNote = {
  id: string;
  title: string;
  folderId: string | null;
  trashedAt: string;
  version: number;
  excerpt: string;
};

export type VisualizationQueryResponse = {
  notes: VisualizationNote[];
  trash?: VisualizationTrashNote[];
  sequence: number;
};

/** Structured events emitted only by the sandbox runner's trusted DOM event handlers. */
export type VisualizationUiEvent =
  | { type: "state.set"; key: string; value: VisualizationValue }
  | { type: "state.toggle"; key: string }
  | { type: "note.open"; noteId: string }
  | { type: "note.create"; fields: Record<string, string> }
  | { type: "note.update"; noteId: string; fields: Record<string, string> }
  | { type: "note.frontmatter.patch"; noteId: string; fields: Record<string, string> }
  | { type: "note.trash"; noteId: string }
  | { type: "trash.restore"; noteId: string }
  | { type: "movies.search"; fields: Record<string, string> };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_EVENT_KEY = /^(?!__proto__$|prototype$|constructor$)[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVisualizationValue(value: unknown, depth = 0): value is VisualizationValue {
  if (depth > 6) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return typeof value !== "string" || value.length <= 4_000;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 50 && value.every((item) => isVisualizationValue(item, depth + 1));
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 50 && entries.every(([key, child]) => SAFE_EVENT_KEY.test(key) && isVisualizationValue(child, depth + 1));
}

function isStringFields(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 32 && entries.every(([key, child]) => SAFE_EVENT_KEY.test(key) && typeof child === "string" && child.length <= 4_000);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Parse the iframe's untrusted structured-clone payload into the host action vocabulary. */
export function parseVisualizationUiEvent(value: unknown): VisualizationUiEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "state.set":
      return hasOnlyKeys(value, ["type", "key", "value"]) && typeof value.key === "string"
        && SAFE_EVENT_KEY.test(value.key) && isVisualizationValue(value.value)
        ? { type: "state.set", key: value.key, value: value.value }
        : null;
    case "state.toggle":
      return hasOnlyKeys(value, ["type", "key"]) && typeof value.key === "string" && SAFE_EVENT_KEY.test(value.key)
        ? { type: "state.toggle", key: value.key }
        : null;
    case "note.open":
    case "note.trash":
    case "trash.restore":
      return hasOnlyKeys(value, ["type", "noteId"]) && typeof value.noteId === "string" && UUID_PATTERN.test(value.noteId)
        ? { type: value.type, noteId: value.noteId }
        : null;
    case "note.create":
    case "movies.search":
      return hasOnlyKeys(value, ["type", "fields"]) && isStringFields(value.fields)
        ? { type: value.type, fields: value.fields }
        : null;
    case "note.update":
    case "note.frontmatter.patch":
      return hasOnlyKeys(value, ["type", "noteId", "fields"]) && typeof value.noteId === "string"
        && UUID_PATTERN.test(value.noteId) && isStringFields(value.fields)
        ? { type: value.type, noteId: value.noteId, fields: value.fields }
        : null;
    default:
      return null;
  }
}

/** Mutating API messages accepted by the Fieldnotes host; never accepted from iframe URLs. */
export type VisualizationAction =
  | { type: "note.create"; actionId: string; title: string; body?: string; frontmatter?: Record<string, VisualizationValue>; folderId?: string | null }
  | { type: "note.update"; id: string; expectedVersion: number; expectedHash: string; title?: string; body?: string; frontmatterPatch?: Record<string, VisualizationValue>; folderId?: string | null }
  | { type: "note.frontmatter.patch"; id: string; expectedVersion: number; expectedHash: string; patch: Record<string, VisualizationValue> }
  | { type: "note.trash"; id: string; expectedVersion: number; expectedHash: string }
  | { type: "trash.restore"; id: string; expectedVersion: number; folderId?: string | null }
  | { type: "movies.search"; provider: "tmdb"; query: string; language?: string };

export type MovieSearchResult = {
  id: number;
  title: string;
  originalTitle: string;
  releaseDate: string | null;
  overview: string;
  posterPath: string | null;
};

export type FieldnotesViewConfig = {
  version: 1;
  view: "table" | "calendar" | "custom";
  query?: VisualizationQuery;
  columns?: string[];
  dateField?: string;
  labelField?: string;
  js?: string;
};
