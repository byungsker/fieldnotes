export class VaultStorageError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "vault_unavailable", status = 503) {
    super(message);
    this.name = "VaultStorageError";
    this.code = code;
    this.status = status;
  }
}

export class VaultVersionConflictError extends VaultStorageError {
  readonly currentVersion: number;
  readonly currentHash: string;

  constructor(currentVersion: number, currentHash: string) {
    super("The Markdown file changed on disk. Load the latest version before saving again.", "version_conflict", 409);
    this.name = "VaultVersionConflictError";
    this.currentVersion = currentVersion;
    this.currentHash = currentHash;
  }
}
