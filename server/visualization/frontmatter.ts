import type { VisualizationValue } from "../../shared/visualization.js";

type Frame = { indent: number; container: Record<string, VisualizationValue> | VisualizationValue[] };

function splitInline(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function stripYamlComment(value: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = null;
    } else if (character === "'" || character === '"') quote = character;
    else if (character === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) return value.slice(0, index).trimEnd();
  }
  return value;
}

function scalar(raw: string, depth = 0): VisualizationValue {
  if (depth > 8) throw new Error("Frontmatter nesting is too deep.");
  const value = stripYamlComment(raw).trim();
  if (!value) return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner ? splitInline(inner).map((part) => scalar(part, depth + 1)) : [];
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed);
        if (entries.length > 50) return value;
        const record: Record<string, VisualizationValue> = {};
        for (const [key, child] of entries) {
          if (!WRITABLE_KEY.test(key) || !isWritableValue(child, depth + 1)) return value;
          record[key] = child;
        }
        return record;
      }
    } catch (error) {
      if (error instanceof SyntaxError) return value;
      throw error;
    }
  }
  if (/^(?:null|~)$/i.test(value)) return null;
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

function nextContentLine(lines: string[], from: number): { index: number; indent: number; text: string } | undefined {
  for (let index = from; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    if (!text.trim() || /^\s*#/.test(text)) continue;
    return { index, indent: /^ */.exec(text)?.[0].length ?? 0, text: text.trim() };
  }
  return undefined;
}

function assign(
  container: Record<string, VisualizationValue>,
  key: string,
  rawValue: string,
  lines: string[],
  lineIndex: number,
  indent: number,
): { value: VisualizationValue; nextIndex: number; child?: Frame } {
  if (rawValue === "|" || rawValue === ">" || rawValue === "|-" || rawValue === ">-") {
    const chunks: string[] = [];
    let nextIndex = lineIndex + 1;
    while (nextIndex < lines.length) {
      const line = lines[nextIndex] ?? "";
      const lineIndent = /^ */.exec(line)?.[0].length ?? 0;
      if (line.trim() && lineIndent <= indent) break;
      chunks.push(line.trim() ? line.slice(Math.min(lineIndent, indent + 2)) : "");
      nextIndex += 1;
    }
    const folded = rawValue.startsWith(">") ? chunks.join(" ").replace(/\s+/g, " ") : chunks.join("\n");
    const result = rawValue.endsWith("-") ? folded : `${folded}\n`;
    container[key] = result;
    return { value: result, nextIndex };
  }

  if (rawValue.trim()) {
    const result = scalar(rawValue);
    container[key] = result;
    return { value: result, nextIndex: lineIndex + 1 };
  }

  const next = nextContentLine(lines, lineIndex + 1);
  const child: Record<string, VisualizationValue> | VisualizationValue[] = next && next.indent > indent && next.text.startsWith("-") ? [] : {};
  container[key] = child;
  return { value: child, nextIndex: lineIndex + 1, child: { indent, container: child } };
}

/** Parse the safe scalar, list, and mapping subset used by Fieldnotes frontmatter. */
export function parseFrontmatter(markdown: string): { values: Record<string, VisualizationValue>; error?: string } {
  const source = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;
  const lines = source.split(/\r?\n/u);
  if (lines[0] !== "---") return { values: {} };
  const closing = lines.findIndex((line, index) => index > 0 && (line === "---" || line === "..."));
  if (closing < 0) return { values: {}, error: "Frontmatter is not closed." };

  const root: Record<string, VisualizationValue> = {};
  const stack: Frame[] = [{ indent: -1, container: root }];
  let sequenceIndex: number | undefined;
  try {
    for (let index = 1; index < closing; index += 1) {
      const original = lines[index] ?? "";
      if (!original.trim() || /^\s*#/.test(original)) continue;
      if (/\t/.test(original)) throw new Error("Tabs are not supported in frontmatter indentation.");
      const indent = /^ */.exec(original)?.[0].length ?? 0;
      while (stack.length > 1 && indent <= (stack.at(-1)?.indent ?? -1)) stack.pop();
      const frame = stack.at(-1);
      if (!frame) throw new Error("Frontmatter structure is invalid.");

      const sequenceMatch = /^-(?:\s+(.*)|\s*)$/.exec(original.slice(indent));
      if (sequenceMatch) {
        if (!Array.isArray(frame.container)) throw new Error("List item has no list key.");
        const item = sequenceMatch[1] ?? "";
        const mappingItem = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(item);
        if (mappingItem) {
          const object: Record<string, VisualizationValue> = {};
          frame.container.push(object);
          stack.push({ indent, container: object });
          const key = mappingItem[1] ?? "";
          if (!WRITABLE_KEY.test(key)) throw new Error("Unsafe frontmatter mapping key.");
          const assigned = assign(object, key, mappingItem[2] ?? "", lines, index, indent + 2);
          if (assigned.child) stack.push(assigned.child);
          if (assigned.nextIndex > index + 1) index = assigned.nextIndex - 1;
          sequenceIndex = undefined;
        } else {
          frame.container.push(scalar(item));
          sequenceIndex = frame.container.length - 1;
        }
        continue;
      }

      if (Array.isArray(frame.container)) {
        if (sequenceIndex === undefined) throw new Error("Expected a list item.");
        const item = frame.container[sequenceIndex];
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Expected a mapping list item.");
        const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(original.slice(indent));
        if (!match) throw new Error("Expected a frontmatter key and value.");
        if (!WRITABLE_KEY.test(match[1] ?? "")) throw new Error("Unsafe frontmatter mapping key.");
        const assigned = assign(item, match[1] ?? "", match[2] ?? "", lines, index, indent);
        if (assigned.child) stack.push(assigned.child);
        if (assigned.nextIndex > index + 1) index = assigned.nextIndex - 1;
        continue;
      }

      const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(original.slice(indent));
      if (!match) throw new Error("Expected a frontmatter key and value.");
      if (!WRITABLE_KEY.test(match[1] ?? "")) throw new Error("Unsafe frontmatter mapping key.");
      const assigned = assign(frame.container, match[1] ?? "", match[2] ?? "", lines, index, indent);
      if (assigned.child) stack.push(assigned.child);
      if (assigned.nextIndex > index + 1) index = assigned.nextIndex - 1;
    }
    return { values: root };
  } catch (error) {
    return { values: root, error: error instanceof Error ? error.message : "Frontmatter could not be read." };
  }
}

const WRITABLE_KEY = /^(?!__proto__$|prototype$|constructor$)[A-Za-z0-9_.-]{1,80}$/;

function isWritableValue(value: unknown, depth = 0): value is VisualizationValue {
  if (depth > 6) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 50 && value.every((item) => isWritableValue(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value);
  return entries.length <= 50 && entries.every(([key, item]) => WRITABLE_KEY.test(key) && isWritableValue(item, depth + 1));
}

function lineContent(line: string): string {
  return line.replace(/(?:\r\n|\n|\r)$/u, "");
}

function splitLinesPreservingEndings(source: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\n" && source[index] !== "\r") continue;
    const end = source[index] === "\r" && source[index + 1] === "\n" ? index + 2 : index + 1;
    lines.push(source.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < source.length) lines.push(source.slice(start));
  return lines;
}

function commentIndex(value: string): number {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = null;
    } else if (character === "'" || character === '"') quote = character;
    else if (character === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) return index;
  }
  return -1;
}

function frontmatterLineEnd(lines: string[]): number | null {
  if (lineContent(lines[0] ?? "") !== "---") return null;
  return lines.findIndex((line, index) => index > 0 && ["---", "..."].includes(lineContent(line)));
}

function yamlJsonValue(value: VisualizationValue): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > 4_000) throw new Error("Frontmatter values must be valid JSON and no larger than 4 KB.");
  return serialized;
}

/** Serialize a small frontmatter mapping without evaluating YAML tags or expressions. */
export function serializeFrontmatter(values: Record<string, VisualizationValue>): string {
  const entries = Object.entries(values);
  if (entries.length > 50 || entries.some(([key, value]) => !WRITABLE_KEY.test(key) || !isWritableValue(value))) {
    throw new Error("Frontmatter must use up to 50 simple, supported key/value entries.");
  }
  return entries.map(([key, value]) => `${key}: ${yamlJsonValue(value)}`).join("\n");
}

/**
 * Patch only top-level keys that can be safely replaced in place. Unchanged
 * comments, delimiters, line endings, and Markdown body bytes stay untouched.
 * Block-style values are rejected rather than rewritten lossy.
 */
export function patchFrontmatter(markdown: string, patch: Record<string, VisualizationValue>): string {
  const entries = Object.entries(patch);
  if (!entries.length) throw new Error("Provide at least one frontmatter field to update.");
  if (entries.length > 50 || entries.some(([key, value]) => !WRITABLE_KEY.test(key) || !isWritableValue(value))) {
    throw new Error("Frontmatter patches must use up to 50 supported keys and values.");
  }

  const hasBom = markdown.startsWith("\uFEFF");
  const bom = hasBom ? "\uFEFF" : "";
  const source = hasBom ? markdown.slice(1) : markdown;
  const lines = splitLinesPreservingEndings(source);
  const closing = frontmatterLineEnd(lines);
  if (closing === null || closing < 0) {
    const newline = source.includes("\r\n") ? "\r\n" : source.includes("\r") && !source.includes("\n") ? "\r" : "\n";
    const frontmatter = entries.map(([key, value]) => `${key}: ${yamlJsonValue(value)}`).join(newline);
    return `${bom}---${newline}${frontmatter}${newline}---${newline}${source}`;
  }
  const newline = /(?:\r\n|\n|\r)$/.exec(lines[0] ?? "")?.[0] ?? "\n";
  const remaining = new Map(entries);
  for (let index = 1; index < closing; index += 1) {
    const content = lineContent(lines[index] ?? "");
    const match = /^([A-Za-z0-9_.-]+)([ \t]*:[ \t]*)(.*)$/u.exec(content);
    if (!match) continue;
    const key = match[1] ?? "";
    if (!remaining.has(key)) continue;
    const duplicate = lines.slice(index + 1, closing).some((line) => {
      const nextKey = /^([A-Za-z0-9_.-]+)[ \t]*:/u.exec(lineContent(line));
      return nextKey?.[1] === key;
    });
    if (duplicate) throw new Error(`Frontmatter field “${key}” occurs more than once; edit it in the note source.`);
    for (let child = index + 1; child < closing; child += 1) {
      const childContent = lineContent(lines[child] ?? "");
      if (childContent.trim() && !/^\s*#/u.test(childContent) && /^\s/u.test(childContent)) {
        throw new Error(`Frontmatter field “${key}” uses a block value; edit it in the note source to preserve its formatting.`);
      }
      if (childContent.trim() && !/^\s*#/u.test(childContent) && !/^\s/u.test(childContent)) break;
    }
    const originalValue = match[3] ?? "";
    const comment = commentIndex(originalValue);
    const suffix = comment >= 0 ? originalValue.slice(comment === 0 ? comment : comment - 1) : "";
    const valuePart = comment >= 0 ? originalValue.slice(0, comment).trimEnd() : originalValue.trimEnd();
    if (/^(?:\||>|\|-|>-)$/u.test(valuePart.trim())) {
      throw new Error(`Frontmatter field “${key}” uses a block value; edit it in the note source to preserve its formatting.`);
    }
    const value = remaining.get(key);
    if (value === undefined && !remaining.has(key)) continue;
    const existingSpacing = /:[ \t]*/u.exec(match[2])?.[0] ?? ": ";
    const newSpacing = existingSpacing === ":" ? ": " : existingSpacing;
    const lineEnding = /(?:\r\n|\n|\r)$/u.exec(lines[index] ?? "")?.[0] ?? "";
    lines[index] = `${match[1]}${newSpacing}${yamlJsonValue(value as VisualizationValue)}${suffix}${lineEnding}`;
    remaining.delete(key);
  }

  if (remaining.size) {
    const additions = [...remaining.entries()].map(([key, value]) => `${key}: ${yamlJsonValue(value)}${newline}`);
    lines.splice(closing, 0, ...additions);
  }
  return bom + lines.join("");
}
