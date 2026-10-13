import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { FileVault, VaultStorageError } from "./vault.js";

const SETTINGS_FILE = ".fieldnotes-vault-selection.json";
const SETTINGS_VERSION = 1;
const MAX_RELATIVE_PATH_LENGTH = 500;

type SavedSelection = { version: 1; relativePath: string };
export type VaultDirectoryEntry = { name: string; relativePath: string };
export type VaultDirectoryListing = { relativePath: string; directories: VaultDirectoryEntry[] };
export type VaultSettingsState = {
  currentPath: string | null;
  selectedPath: string | null;
  configuredPath: string | null;
  restartRequired: boolean;
  documentsRoot: string;
};

function fail(message: string, code: string, status = 400): never {
  throw new VaultStorageError(message, code, status);
}

function lstatIfPresent(filePath: string): Stats | null {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_RELATIVE_PATH_LENGTH || value.includes("\\") || value.includes("\0")) {
    fail("Choose a folder inside the server Mac's Documents directory.", "vault_path_invalid");
  }
  if (value === "") return "";
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    fail("Choose a visible folder inside the server Mac's Documents directory.", "vault_path_invalid");
  }
  return segments.join("/");
}

function safeSelectedFolderPath(value: unknown): string {
  const relativePath = safeRelativePath(value);
  if (!relativePath) fail("Choose a folder inside the server Mac's Documents directory.", "vault_path_invalid");
  return relativePath;
}

function assertDirectoryWithoutSymlinks(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  let current = resolvedRoot;
  try {
    const rootStat = lstatSync(resolvedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("The server Mac's Documents folder is unavailable.", "documents_root_unavailable", 409);
  } catch (error) {
    if (error instanceof VaultStorageError) throw error;
    fail("The server Mac's Documents folder is unavailable.", "documents_root_unavailable", 409);
  }
  for (const segment of relativePath ? relativePath.split("/") : []) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) fail("Symbolic links are not allowed in the selected folder path.", "vault_symlink");
      if (!stat.isDirectory()) fail("The selected folder path contains a non-directory entry.", "vault_path_invalid");
    } catch (error) {
      if (error instanceof VaultStorageError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("The selected folder no longer exists.", "vault_target_missing", 409);
      throw error;
    }
  }
  const relative = path.relative(resolvedRoot, current);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("The selected folder must stay inside the server Mac's Documents directory.", "vault_path_invalid");
  }
  return current;
}

function inspectCandidate(documentsRoot: string, relativePath: string): { absolutePath: string; state: "empty" | "managed" } {
  const absolutePath = assertDirectoryWithoutSymlinks(documentsRoot, relativePath);
  return { absolutePath, state: FileVault.inspectTarget(absolutePath) };
}

export class VaultSettingsService {
  readonly documentsRoot: string;
  readonly settingsPath: string;

  constructor(
    readonly dataDirectory: string,
    private readonly currentVaultPath: string | null,
    documentsRoot: string,
    private readonly configuredVaultPath: string | null = process.env.KB_VAULT_DIR?.trim() ? path.resolve(process.env.KB_VAULT_DIR) : null,
  ) {
    this.documentsRoot = path.resolve(documentsRoot);
    this.settingsPath = path.join(path.resolve(dataDirectory), SETTINGS_FILE);
  }

  getState(): VaultSettingsState {
    const selection = this.readSelection();
    const selectedPath = selection ? inspectCandidate(this.documentsRoot, selection.relativePath).absolutePath : null;
    const effectivePath = selectedPath ?? this.configuredVaultPath;
    return {
      currentPath: this.currentVaultPath,
      selectedPath,
      configuredPath: this.configuredVaultPath,
      restartRequired: effectivePath !== this.currentVaultPath,
      documentsRoot: this.documentsRoot,
    };
  }

  listDirectories(relativePathValue: unknown): VaultDirectoryListing {
    const relativePath = safeRelativePath(relativePathValue ?? "");
    const absolutePath = assertDirectoryWithoutSymlinks(this.documentsRoot, relativePath);
    const directories: VaultDirectoryEntry[] = [];
    for (const name of readdirSync(absolutePath)) {
      if (!name || name.startsWith(".") || name.includes("\\")) continue;
      const candidate = path.join(absolutePath, name);
      try {
        const stat = lstatSync(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        directories.push({ name, relativePath: relativePath ? `${relativePath}/${name}` : name });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    directories.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    return { relativePath, directories };
  }

  verify(relativePathValue: unknown): { absolutePath: string; state: "empty" | "managed" } {
    return inspectCandidate(this.documentsRoot, safeSelectedFolderPath(relativePathValue));
  }

  saveSelection(relativePathValue: unknown): VaultSettingsState {
    const relativePath = safeSelectedFolderPath(relativePathValue);
    inspectCandidate(this.documentsRoot, relativePath);
    const directoryStat = lstatSync(path.dirname(this.settingsPath));
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
      fail("Fieldnotes settings must be stored in a private data directory.", "vault_settings_storage_invalid", 409);
    }
    const existingSettings = lstatIfPresent(this.settingsPath);
    if (existingSettings && (existingSettings.isSymbolicLink() || !existingSettings.isFile())) {
      fail("The saved vault selection file is not a regular file.", "vault_settings_storage_invalid", 409);
    }
    const temporaryPath = `${this.settingsPath}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify({ version: SETTINGS_VERSION, relativePath } satisfies SavedSelection)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      renameSync(temporaryPath, this.settingsPath);
    } catch (error) {
      try { closeSync(descriptor); } catch { /* the descriptor may already be closed */ }
      try { unlinkSync(temporaryPath); } catch { /* best-effort temporary-file cleanup */ }
      throw error;
    }
    return this.getState();
  }

  clearSelection(): VaultSettingsState {
    const stat = lstatIfPresent(this.settingsPath);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isFile()) fail("The saved vault selection file is not a regular file.", "vault_settings_storage_invalid", 409);
      unlinkSync(this.settingsPath);
    }
    return this.getState();
  }

  readSavedSelection(): { absolutePath: string; relativePath: string } | null {
    const selection = this.readSelection();
    if (!selection) return null;
    const candidate = inspectCandidate(this.documentsRoot, selection.relativePath);
    return { absolutePath: candidate.absolutePath, relativePath: selection.relativePath };
  }

  private readSelection(): SavedSelection | null {
    const stat = lstatIfPresent(this.settingsPath);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2_048 || (stat.mode & 0o077) !== 0) {
      fail("The saved vault selection file is invalid; inspect it before restarting.", "vault_settings_storage_invalid", 409);
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.settingsPath, "utf8"));
    } catch {
      fail("The saved vault selection file is unreadable; inspect it before restarting.", "vault_settings_storage_invalid", 409);
    }
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== SETTINGS_VERSION
      || Object.keys(value).some((key) => !["version", "relativePath"].includes(key))) {
      fail("The saved vault selection file has an unsupported format.", "vault_settings_storage_invalid", 409);
    }
    return { version: SETTINGS_VERSION, relativePath: safeSelectedFolderPath((value as { relativePath?: unknown }).relativePath) };
  }
}

export function resolveSavedVaultSelection(dataDirectory: string, documentsRoot: string): { absolutePath: string; relativePath: string } | null {
  return new VaultSettingsService(dataDirectory, null, documentsRoot).readSavedSelection();
}
