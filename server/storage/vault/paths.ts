import { TEMP_PREFIX } from "./constants.js";

export function normalizedNameKey(value: string): string {
  return value.normalize("NFD").toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ").replace(/[ .]+$/u, "");
}

export function normalizedRelativeKey(value: string): string {
  return value.split("/").map(normalizedNameKey).join("/");
}

export function relativePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function parentPath(value: string): string {
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
}

export function basename(value: string): string {
  const index = value.lastIndexOf("/");
  return index < 0 ? value : value.slice(index + 1);
}

export function titleFromFileName(name: string, id?: string): string {
  let stem = name.replace(/\.(?:md|markdown)$/i, "");
  if (id) {
    const suffix = `--${id.slice(0, 8)}`;
    if (stem.endsWith(suffix)) stem = stem.slice(0, -suffix.length);
  }
  try {
    return decodeURIComponent(stem) || "Untitled";
  } catch {
    return stem || "Untitled";
  }
}

function encodedNameTokens(title: string): string[] {
  const chars = [...title.normalize("NFC")];
  return chars.map((character, index) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const encode = /[%/\\:*?"<>|]/u.test(character)
      || codePoint < 32
      || codePoint === 127
      || (index === 0 && character === ".")
      || (index === chars.length - 1 && (character === "." || character === " "));
    if (!encode) return character;
    return [...Buffer.from(character, "utf8")].map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`).join("");
  });
}

function truncateTokens(tokens: string[], maxBytes: number): string {
  let result = "";
  let length = 0;
  for (const token of tokens) {
    const bytes = Buffer.byteLength(token, "utf8");
    if (length + bytes > maxBytes) break;
    result += token;
    length += bytes;
  }
  return result;
}

export function safeNoteFileName(title: string, id: string, collision = false): string {
  const tokens = encodedNameTokens(title);
  const base = tokens.join("") || "Untitled";
  const useSuffix = collision || Buffer.byteLength(`${base}.md`, "utf8") > 220;
  const suffix = useSuffix ? `--${id.slice(0, 8)}` : "";
  const stem = useSuffix ? `${truncateTokens(tokens, 190) || "Untitled"}${suffix}` : base;
  return `${stem}.md`;
}

export function safeFolderSegment(name: string, id: string, collision = false): string {
  const tokens = encodedNameTokens(name);
  const base = tokens.join("") || "Folder";
  const useSuffix = collision || Buffer.byteLength(base, "utf8") > 200 || base.startsWith(TEMP_PREFIX);
  const suffix = useSuffix ? `--${id.slice(0, 8)}` : "";
  return useSuffix ? `${truncateTokens(tokens, 170) || "Folder"}${suffix}` : base;
}
