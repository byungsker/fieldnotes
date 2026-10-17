import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ViewQueryLimitError, VIEW_TRASH_LIMIT_MESSAGE } from "../../view-query-limits.js";
import { TEMP_PREFIX, MAX_VAULT_FILE_BYTES } from "./constants.js";
import { VaultStorageError } from "./errors.js";
import type { FileKey } from "./types.js";

export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileKey(absolutePath: string): FileKey {
  const stat = lstatSync(absolutePath, { bigint: true });
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

export function statKind(absolutePath: string): "file" | "directory" | "symlink" | "other" {
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

export function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Some filesystems do not support fsync on directories. File contents are still fsynced.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeAtomic(absolutePath: string, bytes: Buffer): void {
  const directory = path.dirname(absolutePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `${TEMP_PREFIX}${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, absolutePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function writeNewDurable(absolutePath: string, bytes: Buffer, mode = 0o600): void {
  const directory = path.dirname(absolutePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(absolutePath, "wx", mode);
    created = true;
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created && existsSync(absolutePath)) unlinkSync(absolutePath);
    throw error;
  }
}

export function readDescriptorBounded(
  descriptor: number,
  maxBytes: number,
  reader: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number = readSync,
  maxAllowedBytes = MAX_VAULT_FILE_BYTES,
): { bytes: Buffer; exceededLimit: boolean } {
  if (!Number.isSafeInteger(maxAllowedBytes) || maxAllowedBytes < 0
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > maxAllowedBytes) {
    throw new RangeError("The bounded descriptor read limit is outside the vault file size range.");
  }
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total < buffer.byteLength) {
    const bytesRead = reader(descriptor, buffer, total, buffer.byteLength - total, null);
    if (bytesRead === 0) break;
    if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength - total) {
      throw new VaultStorageError("The vault file could not be read safely.", "vault_read_failed", 500);
    }
    total += bytesRead;
  }
  return { bytes: buffer.subarray(0, Math.min(total, maxBytes)), exceededLimit: total > maxBytes };
}

function assertOpenedPathWithinRoot(absolutePath: string, allowedRoot: string, descriptorStat: { dev: bigint; ino: bigint }): void {
  try {
    const resolvedRoot = realpathSync(allowedRoot);
    const resolvedFile = realpathSync(absolutePath);
    const relative = path.relative(resolvedRoot, resolvedFile);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new VaultStorageError("The referenced vault asset changed path while it was opened.", "vault_path_changed", 409);
    }
    const pathStat = statSync(resolvedFile, { bigint: true });
    if (!pathStat.isFile() || pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
      throw new VaultStorageError("The referenced vault asset changed path while it was opened.", "vault_path_changed", 409);
    }
  } catch (error) {
    if (error instanceof VaultStorageError) throw error;
    throw new VaultStorageError("The referenced vault asset changed path while it was opened.", "vault_path_changed", 409);
  }
}

export function readRegularFileNoFollow(
  absolutePath: string,
  maxBytes = MAX_VAULT_FILE_BYTES,
  allowedRoot?: string,
  maxAllowedBytes = MAX_VAULT_FILE_BYTES,
): Buffer {
  let descriptor: number | undefined;
  try {
    if (!Number.isSafeInteger(maxAllowedBytes) || maxAllowedBytes < 0
      || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("The vault file size limit is invalid.");
    }
    descriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) throw new VaultStorageError("Expected a regular file; symbolic links are not followed.", "vault_symlink", 409);
    const effectiveMaxBytes = Math.min(maxBytes, maxAllowedBytes);
    if (stat.size > BigInt(effectiveMaxBytes)) {
      if (allowedRoot || maxBytes < maxAllowedBytes) throw new ViewQueryLimitError(VIEW_TRASH_LIMIT_MESSAGE);
      throw new VaultStorageError(`Markdown file exceeds the ${MAX_VAULT_FILE_BYTES} byte vault limit.`, "vault_file_too_large", 409);
    }
    if (allowedRoot) assertOpenedPathWithinRoot(absolutePath, allowedRoot, stat);
    const result = readDescriptorBounded(descriptor, effectiveMaxBytes, readSync, maxAllowedBytes);
    if (result.exceededLimit) {
      if (allowedRoot || maxBytes < maxAllowedBytes) throw new ViewQueryLimitError(VIEW_TRASH_LIMIT_MESSAGE);
      throw new VaultStorageError(`Markdown file exceeds the ${MAX_VAULT_FILE_BYTES} byte vault limit.`, "vault_file_too_large", 409);
    }
    return result.bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new VaultStorageError("Symbolic links are not allowed inside a Fieldnotes vault.", "vault_symlink", 409);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function exactEntryExists(parentAbsolute: string, name: string): boolean {
  try {
    return readdirSync(parentAbsolute).includes(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
