import type { Request } from "express";

export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 160;
const MAX_FOLDER_NAME_LENGTH = 120;
const MAX_BODY_LENGTH = 250_000;

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export function validateDocumentId(value: string): string {
  if (!ID_PATTERN.test(value)) throw new RequestValidationError("Note id must be a UUID.");
  return value;
}

export function requestDocumentId(request: Request): string {
  const value = request.params.id;
  if (typeof value !== "string") throw new RequestValidationError("Note id must be a UUID.");
  return validateDocumentId(value);
}

export function validateFolderId(value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new RequestValidationError("Folder id must be a UUID.");
  }
  return value;
}

export function requestFolderId(request: Request): string {
  return validateFolderId(request.params.id);
}

export function validateFolderName(value: unknown): string {
  if (typeof value !== "string") throw new RequestValidationError("Folder name must be text.");
  const name = value.trim();
  if (!name) throw new RequestValidationError("Folder name cannot be empty.");
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    throw new RequestValidationError(`Folder name must be ${MAX_FOLDER_NAME_LENGTH} characters or fewer.`);
  }
  if (Buffer.byteLength(name, "utf8") > 200) throw new RequestValidationError("Folder names must fit within 200 UTF-8 bytes on disk.");
  const hasControlCharacter = [...name].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  const normalizedName = name.normalize("NFC");
  const portableNameKey = normalizedName.normalize("NFD").toLowerCase();
  if (name === "." || name === ".." || portableNameKey === ".fieldnotes" || portableNameKey.startsWith(".fieldnotes-tmp-") || name.endsWith(".") || name.endsWith(" ") || name.includes("/") || name.includes("\\") || hasControlCharacter) {
    throw new RequestValidationError("Folder names cannot contain path separators or control characters.");
  }
  return normalizedName;
}

export function validateFolderParent(value: unknown): string | null {
  if (value === null) return null;
  return validateFolderId(value);
}

export function validateTitle(value: unknown): string {
  if (typeof value !== "string") throw new RequestValidationError("Title must be text.");
  const title = value.trim();
  if (!title) throw new RequestValidationError("Title cannot be empty.");
  if (title.length > MAX_TITLE_LENGTH) throw new RequestValidationError(`Title must be ${MAX_TITLE_LENGTH} characters or fewer.`);
  return title;
}

export function validateBody(value: unknown): string {
  if (typeof value !== "string") throw new RequestValidationError("Markdown body must be text.");
  if (value.length > MAX_BODY_LENGTH) throw new RequestValidationError("Markdown body is too large (250 KB maximum).");
  return value;
}

export function validateVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RequestValidationError("expectedVersion must be a positive integer.");
  }
  return version;
}

export function validateHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new RequestValidationError("expectedHash must be a SHA-256 hex digest.");
  }
  return value.toLowerCase();
}

export function validateRequiredHash(value: unknown): string {
  const hash = validateHash(value);
  if (!hash) throw new RequestValidationError("expectedHash must be a SHA-256 hex digest.");
  return hash;
}
