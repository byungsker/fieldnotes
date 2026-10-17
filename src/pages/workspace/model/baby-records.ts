import type { MarkdownPreviewContext, PreviewDocument } from "../../../../packages/markdown-live-editor";
import { splitLeadingFrontmatter, resolveLocalImageAssetPath } from "../../../../packages/markdown-live-editor";
import type { BabiesPreviewAdapters } from "./baby-preview";

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };
export type RecordData = {
  document: PreviewDocument;
  date: string;
  ageDays: number | null;
  ageText: string;
  highlight: string;
  milestones: Array<{ child: string; text: string }>;
  goals: string[];
};

type ViewKind = "dashboard" | "new-entry" | "schedule" | "milestones";

function stripYamlComment(value: string): string {
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function splitYamlItems(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quote = "";
  let square = 0;
  let curly = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
    } else if (character === "'" || character === '"') quote = character;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    else if (character === "," && square === 0 && curly === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const final = value.slice(start).trim();
  if (final) items.push(final);
  return items;
}

function parseYamlScalar(input: string): YamlValue {
  const value = stripYamlComment(input).trim();
  if (!value || value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitYamlItems(value.slice(1, -1)).map(parseYamlScalar);
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const result: Record<string, YamlValue> = {};
    for (const item of splitYamlItems(value.slice(1, -1))) {
      const colon = item.indexOf(":");
      if (colon > 0) result[item.slice(0, colon).trim().replace(/^['"]|['"]$/gu, "")] = parseYamlScalar(item.slice(colon + 1));
    }
    return result;
  }
  return value;
}

type YamlLine = { indent: number; text: string };

function parseYamlLines(lines: YamlLine[]): Record<string, YamlValue> {
  function parseBlock(start: number, indent: number): [YamlValue, number] {
    const isSequence = /^-(?:\s|$)/u.test(lines[start]?.text ?? "");
    if (isSequence) return parseSequence(start, indent);
    return parseMapping(start, indent, {});
  }

  function parseMapping(start: number, indent: number, result: Record<string, YamlValue>): [YamlValue, number] {
    let index = start;
    while (index < lines.length) {
      const line = lines[index];
      if (!line || line.indent < indent || line.indent !== indent || /^-(?:\s|$)/u.test(line.text)) break;
      const match = /^([^:#][^:]*):(?:\s*(.*))?$/u.exec(line.text);
      if (!match) { index += 1; continue; }
      const key = (match[1] ?? "").trim().replace(/^['"]|['"]$/gu, "");
      const inline = match[2] ?? "";
      index += 1;
      if (inline.trim()) {
        result[key] = parseYamlScalar(inline);
      } else if (index < lines.length && (lines[index]?.indent ?? 0) > indent) {
        const [nested, nextIndex] = parseBlock(index, lines[index]?.indent ?? indent + 1);
        result[key] = nested;
        index = nextIndex;
      } else {
        result[key] = null;
      }
    }
    return [result, index];
  }

  function parseSequence(start: number, indent: number): [YamlValue, number] {
    const values: YamlValue[] = [];
    let index = start;
    while (index < lines.length) {
      const line = lines[index];
      if (!line || line.indent !== indent || !/^-(?:\s|$)/u.test(line.text)) break;
      const itemText = line.text.replace(/^-(?:\s+)?/u, "");
      index += 1;
      if (!itemText) {
        if (index < lines.length && (lines[index]?.indent ?? 0) > indent) {
          const [nested, nextIndex] = parseBlock(index, lines[index]?.indent ?? indent + 1);
          values.push(nested);
          index = nextIndex;
        } else values.push(null);
        continue;
      }
      if (itemText.startsWith("'") || itemText.startsWith('"')) {
        values.push(parseYamlScalar(itemText));
        continue;
      }
      const firstEntry = /^([^:#][^:]*):(?:\s*(.*))?$/u.exec(itemText);
      if (!firstEntry) {
        values.push(parseYamlScalar(itemText));
        continue;
      }
      const result: Record<string, YamlValue> = {};
      const key = (firstEntry[1] ?? "").trim().replace(/^['"]|['"]$/gu, "");
      const inline = firstEntry[2] ?? "";
      if (inline.trim()) result[key] = parseYamlScalar(inline);
      else if (index < lines.length && (lines[index]?.indent ?? 0) > indent + 2) {
        const [nested, nextIndex] = parseBlock(index, lines[index]?.indent ?? indent + 3);
        result[key] = nested;
        index = nextIndex;
      } else result[key] = null;
      const [complete, nextIndex] = parseMapping(index, indent + 2, result);
      values.push(complete);
      index = nextIndex;
    }
    return [values, index];
  }

  if (!lines.length) return {};
  const [parsed] = parseBlock(0, lines[0]?.indent ?? 0);
  return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed : {};
}

export function parseSafeBabyFrontmatter(markdown: string): Record<string, YamlValue> {
  const { frontmatter } = splitLeadingFrontmatter(markdown);
  if (!frontmatter) return {};
  const lines = frontmatter.replace(/^\uFEFF?---\r?\n/u, "").replace(/\r?\n---\s*$/u, "")
    .split(/\r?\n/u)
    .map((text) => ({ indent: text.match(/^ */u)?.[0].length ?? 0, text: stripYamlComment(text.trimStart()) }))
    .filter((line) => line.text.trim());
  return parseYamlLines(lines);
}

export function scalarText(value: YamlValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  return String(value);
}

function collectMilestones(value: YamlValue | undefined, inheritedChild = ""): Array<{ child: string; text: string }> {
  if (Array.isArray(value)) return value.flatMap((item) => collectMilestones(item, inheritedChild));
  if (value && typeof value === "object") {
    const record = value as Record<string, YamlValue>;
    const child = scalarText(record.child ?? record.person ?? record.name) || inheritedChild;
    const label = scalarText(record.milestone ?? record.title ?? record.value ?? record.description);
    if (label) return [{ child: child || "Child", text: label }];
    const ignored = new Set(["child", "person", "name", "date"]);
    return Object.entries(record).flatMap(([key, nested]) => ignored.has(key.toLowerCase()) ? [] : collectMilestones(nested, child || key));
  }
  if (typeof value !== "string" || !value.trim()) return [];
  const text = value.trim();
  const separator = text.indexOf(":");
  if (separator >= 0) return [{ child: text.slice(0, separator).trim(), text: text.slice(separator + 1).trim() }];
  return [{ child: inheritedChild, text }];
}

function collectTextValues(value: YamlValue | undefined): string[] {
  if (Array.isArray(value)) return value.flatMap(collectTextValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectTextValues);
  const text = scalarText(value).trim();
  return text ? [text] : [];
}

export function normalizeRecordDate(value: string): string {
  const date = value.trim().slice(0, 10);
  return Number.isFinite(dateOrdinal(date)) ? date : "";
}

function parseRecord(document: PreviewDocument): RecordData {
  const data = parseSafeBabyFrontmatter(document.body ?? "");
  const age = Number(data.age_days);
  return {
    document,
    date: normalizeRecordDate(scalarText(data.date)),
    ageDays: Number.isFinite(age) ? age : null,
    ageText: scalarText(data.age_str),
    highlight: scalarText(data.highlight),
    milestones: collectMilestones(data.milestones),
    goals: collectTextValues(data.goals),
  };
}

export function detectView(source: string, context: MarkdownPreviewContext): ViewKind | null {
  const code = source.toLowerCase();
  const path = context.documentPath?.replaceAll("\\", "/");
  if (path === "babies/dashboard.md") {
    if (code.includes("dv.pages") && code.includes("babies/records") && (code.includes("age_days") || code.includes("milestones"))) return "dashboard";
    if (code.includes("app.vault.create") && code.includes("babies/records")) return "new-entry";
    if (code.includes("babies/schedule") && code.includes("schedule")) return "schedule";
  }
  if (path === "babies/milestones.md" && code.includes("babies/records") && code.includes("milestones")) return "milestones";
  return null;
}

export function isSupportedBabyDataview(source: string, context: MarkdownPreviewContext): boolean {
  return detectView(source, context) !== null;
}

export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateTime(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return Number.NaN;
  return Date.parse(`${value}T12:00:00`);
}

const DAY_MILLISECONDS = 86_400_000;

type BabySourceSettings = {
  birthday: string | null;
  photoPath: string | null;
  dashboardTitle: string | null;
  girlTokens: string[];
  boyTokens: string[];
  girlLabel: string;
  boyLabel: string;
  dailyTemplate: string | null;
  scheduleAdvice: string;
};

function decodeStaticString(value: string): string {
  return value.replace(/\\r\\n/gu, "\n").replace(/\\n/gu, "\n").replace(/\\r/gu, "\r")
    .replace(/\\(["'\\])/gu, "$1");
}

function extractSourceConstant(source: string, name: string): string | null {
  const match = new RegExp("\\bconst\\s+" + name + "\\s*=\\s*(['\"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1", "u").exec(source);
  return match?.[2] === undefined ? null : decodeStaticString(match[2]);
}

function extractSourceBirthday(source: string): string | null {
  const match = /\bconst\s+BIRTHDAY\s*=\s*new Date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)/u.exec(source);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) + 1;
  const day = Number(match[3]);
  const date = String(year) + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
  return Number.isFinite(dateOrdinal(date)) ? date : null;
}

function extractStaticPhotoPath(source: string): string | null {
  const match = /getAbstractFileByPath\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\)/u.exec(source);
  return match?.[2] === undefined ? null : decodeStaticString(match[2]);
}

function extractDashboardTitle(source: string): string | null {
  const match = /titleEl\.textContent\s*=\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/u.exec(source);
  return match?.[2] === undefined ? null : decodeStaticString(match[2]);
}

function extractScheduleAdvice(source: string): string {
  const match = /note\.innerHTML\s*=\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*;/u.exec(source);
  if (match?.[2] === undefined) return "";
  return decodeStaticString(match[2]).replace(/<br\s*\/?>/giu, "\n").replace(/<\/?strong>/giu, "");
}

export function classifyChild(child: string, settings: BabySourceSettings): "girl" | "boy" | null {
  const isGirl = settings.girlTokens.some((token) => child.includes(token));
  const isBoy = settings.boyTokens.some((token) => child.includes(token));
  if (isGirl === isBoy) return null;
  return isGirl ? "girl" : "boy";
}

function extractStaticTemplate(source: string): string | null {
  const tick = String.fromCharCode(96);
  const pattern = new RegExp("function\\s+buildFileContent\\s*\\(\\s*dateStr\\s*,\\s*age\\s*\\)\\s*\\{\\s*return\\s+" + tick + "([\\s\\S]*?)" + tick + "\\s*;\\s*\\}", "u");
  return pattern.exec(source)?.[1] ?? null;
}

export function readBabySourceSettings(source: string): BabySourceSettings {
  const girlShort = extractSourceConstant(source, "GIRL_SHORT");
  const girlName = extractSourceConstant(source, "GIRL_NAME");
  const boyShort = extractSourceConstant(source, "BOY_SHORT");
  const boyName = extractSourceConstant(source, "BOY_NAME");
  return {
    birthday: extractSourceBirthday(source),
    photoPath: extractStaticPhotoPath(source),
    dashboardTitle: extractDashboardTitle(source),
    girlTokens: [girlShort, girlName].filter((value): value is string => Boolean(value)),
    boyTokens: [boyShort, boyName].filter((value): value is string => Boolean(value)),
    girlLabel: girlShort || girlName || "",
    boyLabel: boyShort || boyName || "",
    dailyTemplate: extractStaticTemplate(source),
    scheduleAdvice: extractScheduleAdvice(source),
  };
}

type AgeCalculation = { totalDays: number; months: number; dayOfMonth: number; text: string };

function dateOrdinal(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ordinal = Date.UTC(year, month - 1, day);
  const date = new Date(ordinal);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? ordinal
    : Number.NaN;
}

function monthOrdinal(birthOrdinal: number, months: number): number {
  const birth = new Date(birthOrdinal);
  const firstOfMonth = new Date(Date.UTC(birth.getUTCFullYear(), birth.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth(), Math.min(birth.getUTCDate(), lastDay));
}

export function calculateAgeOnDate(targetDate: string, anchorDate: string, anchorAgeDays: number): AgeCalculation | null {
  const targetOrdinal = dateOrdinal(targetDate);
  const anchorOrdinal = dateOrdinal(anchorDate);
  if (!Number.isFinite(targetOrdinal) || !Number.isFinite(anchorOrdinal) || !Number.isInteger(anchorAgeDays) || anchorAgeDays < 1) return null;
  const birthOrdinal = anchorOrdinal - (anchorAgeDays - 1) * DAY_MILLISECONDS;
  if (targetOrdinal < birthOrdinal) return null;

  const birth = new Date(birthOrdinal);
  const target = new Date(targetOrdinal);
  let months = (target.getUTCFullYear() - birth.getUTCFullYear()) * 12 + target.getUTCMonth() - birth.getUTCMonth();
  if (monthOrdinal(birthOrdinal, months) > targetOrdinal) months -= 1;
  const dayOfMonth = Math.floor((targetOrdinal - monthOrdinal(birthOrdinal, months)) / DAY_MILLISECONDS) + 1;
  return {
    totalDays: Math.floor((targetOrdinal - birthOrdinal) / DAY_MILLISECONDS) + 1,
    months,
    dayOfMonth,
    text: `${months}개월 ${dayOfMonth}일`,
  };
}

export function calculateAgeFromBirthday(targetDate: string, birthday: string): AgeCalculation | null {
  const targetOrdinal = dateOrdinal(targetDate);
  const birthdayOrdinal = dateOrdinal(birthday);
  if (!Number.isFinite(targetOrdinal) || !Number.isFinite(birthdayOrdinal) || targetOrdinal < birthdayOrdinal) return null;
  return calculateAgeOnDate(targetDate, birthday, 1);
}

function ageForRecords(records: RecordData[], targetDate: string): AgeCalculation | null {
  const targetOrdinal = dateOrdinal(targetDate);
  const anchor = records
    .filter((record) => record.ageDays !== null && Number.isInteger(record.ageDays) && record.ageDays > 0)
    .map((record) => ({ record, ordinal: dateOrdinal(record.date) }))
    .filter((candidate) => Number.isFinite(candidate.ordinal))
    .sort((left, right) => Math.abs(left.ordinal - targetOrdinal) - Math.abs(right.ordinal - targetOrdinal))[0];
  return anchor ? calculateAgeOnDate(targetDate, anchor.record.date, anchor.record.ageDays ?? 0) : null;
}

export function ageForSource(records: RecordData[], date: string, source: string): AgeCalculation | null {
  const birthday = readBabySourceSettings(source).birthday;
  return birthday ? calculateAgeFromBirthday(date, birthday) : ageForRecords(records, date);
}

function renderStaticTemplate(template: string, date: string, age: AgeCalculation): string | null {
  let unsupportedExpression = false;
  const expressionPattern = new RegExp("\\x24\\x7b([^}]+)\\x7d", "gu");
  const rendered = template.replace(expressionPattern, (placeholder, rawExpression: string) => {
    const expression = rawExpression.trim().replace(/\s+/gu, " ");
    if (expression === "dateStr") return date;
    if (expression === "age.str") return age.text;
    if (expression === "age.totalDays + 1" || expression === "totalDays + 1") return String(age.totalDays);
    if (expression === "age.totalDays" || expression === "totalDays") return String(age.totalDays - 1);
    if (expression === "age.months") return String(age.months);
    if (expression === "age.days") return String(age.dayOfMonth - 1);
    if (expression === "months") return String(age.months);
    if (expression === "days + 1") return String(age.dayOfMonth);
    unsupportedExpression = true;
    return placeholder;
  });
  return unsupportedExpression ? null : rendered;
}

export function buildDailyRecordBody(date: string, age: AgeCalculation | null, source = ""): string {
  const template = readBabySourceSettings(source).dailyTemplate;
  if (template && age) {
    const fromSource = renderStaticTemplate(template, date, age);
    if (fromSource !== null) return fromSource;
  }
  return [
    "---",
    "type: daily",
    `date: ${date}`,
    ...(age ? [`age_days: ${age.totalDays}`, `age_str: "${age.text}"`] : []),
    'highlight: ""',
    "milestones: []",
    "tags: []",
    "---",
    "",
    `# ${date}${age ? " — " + age.text : ""}`,
    "",
    "## 📸 Today’s moments",
    "",
    "> Add photos or a note here.",
    "",
    "---",
    "",
    "## Child 1",
    "",
    "",
    "## Child 2",
    "",
    "",
    "---",
    "",
    "## Special events",
    "",
    "## Firsts",
    "",
    "## Next goals / growth",
    "",
  ].join("\n");
}

export async function openOrCreateDailyRecord(
  date: string,
  records: RecordData[],
  context: MarkdownPreviewContext,
  adapters?: BabiesPreviewAdapters,
  source = "",
): Promise<void> {
  const existing = records.find((record) => record.date === date);
  if (existing) {
    openDocument(context, existing.document.id);
    return;
  }
  if (!context.recordsFolderId || !adapters?.createPreviewDocument) throw new Error("The records folder is not available.");
  const document = await adapters.createPreviewDocument({
    title: `${date} record`,
    folderId: context.recordsFolderId,
    body: buildDailyRecordBody(date, ageForSource(records, date, source), source),
  });
  openDocument(context, document.id);
}

export function recordsFromDocuments(documents: PreviewDocument[]): RecordData[] {
  return documents.filter((document) => document.filePath?.startsWith("babies/records/") && typeof document.body === "string")
    .map(parseRecord)
    .filter((record) => Number.isFinite(dateTime(record.date)))
    .sort((left, right) => right.date.localeCompare(left.date));
}

export function localImageReferences(markdown: string, markdownPath?: string): string[] {
  const lines = markdown.split(/\r?\n/u);
  let fence: { marker: string; length: number } | null = null;
  const references = new Set<string>();
  const localImage = (raw: string): string | null => {
    if (markdownPath) return resolveLocalImageAssetPath(raw, markdownPath);
    const target = (raw.split("|")[0] ?? "").split("#")[0]?.split("?")[0]?.trim() ?? "";
    const segments = target.startsWith("/") ? target.slice(1).split("/") : target.split("/");
    if (!target || target.length > 500 || target.includes("\\") || target.startsWith("//")
      || /^[a-z][a-z0-9+.-]*:/iu.test(target)
      || [...target].some((character) => (character.codePointAt(0) ?? 0) < 32 || (character.codePointAt(0) ?? 0) === 127)
      || segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".fieldnotes" || segment.startsWith(".fieldnotes-tmp-"))
      || !/\.(?:avif|gif|jpe?g|png|webp)$/iu.test(target)) return null;
    return target;
  };
  for (const line of lines) {
    const boundary = /^\s{0,3}(\x60{3,}|~{3,})/u.exec(line);
    if (boundary) {
      const marker = boundary[1]?.[0] ?? "\x60";
      const length = boundary[1]?.length ?? 3;
      if (!fence) fence = { marker, length };
      else if (fence.marker === marker && length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const inlineCode = new RegExp("\\x60+[^\\x60\\n]*\\x60+", "gu");
    const searchable = line.replace(inlineCode, "");
    const wikiEmbeds = new RegExp("!\\[\\[([^\\]]+)\\]\\]", "gu");
    for (const match of searchable.matchAll(wikiEmbeds)) {
      const target = localImage(match[1] ?? "");
      if (target) references.add(target);
    }
    const markdownImages = /!\[[^\]]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+["'][^)]*["'])?\)/gu;
    for (const match of searchable.matchAll(markdownImages)) {
      const target = localImage(match[1] ?? match[2] ?? "");
      if (target) references.add(target);
    }
  }
  return [...references];
}

export function firstLocalImageReference(markdown: string): string | null {
  return localImageReferences(markdown)[0] ?? null;
}

export function pngFallbackReference(source: string): string | null {
  return /\.jpe?g$/iu.test(source) ? source.replace(/\.jpe?g$/iu, ".png") : null;
}

export function displayDate(value: string): string {
  const timestamp = dateTime(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(timestamp)
    : value;
}

export function openDocument(context: MarkdownPreviewContext, id: string): void {
  context.onOpenDocument?.(id);
}

export function minutesFromValue(value: YamlValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = /^(\d+(?:\.\d+)?)/u.exec(scalarText(value));
  return match ? Number(match[1]) : 30;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return "";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? hours + "h" + remainder + "m" : hours + "h";
}
