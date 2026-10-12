import type { VisualizationValue } from "../shared/visualization.js";

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
        const assigned = assign(item, match[1] ?? "", match[2] ?? "", lines, index, indent);
        if (assigned.child) stack.push(assigned.child);
        if (assigned.nextIndex > index + 1) index = assigned.nextIndex - 1;
        continue;
      }

      const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(original.slice(indent));
      if (!match) throw new Error("Expected a frontmatter key and value.");
      const assigned = assign(frame.container, match[1] ?? "", match[2] ?? "", lines, index, indent);
      if (assigned.child) stack.push(assigned.child);
      if (assigned.nextIndex > index + 1) index = assigned.nextIndex - 1;
    }
    return { values: root };
  } catch (error) {
    return { values: root, error: error instanceof Error ? error.message : "Frontmatter could not be read." };
  }
}
