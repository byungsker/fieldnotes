export class VersionConflictError extends Error {
  readonly currentVersion: number;
  readonly currentHash?: string;

  constructor(currentVersion: number, currentHash?: string) {
    super("This item changed since you opened it. Load the latest version before saving again.");
    this.name = "VersionConflictError";
    this.currentVersion = currentVersion;
    this.currentHash = currentHash;
  }
}

export class MissingFolderError extends Error {
  constructor() {
    super("Folder not found.");
    this.name = "MissingFolderError";
  }
}

export class FolderNotEmptyError extends Error {
  constructor() {
    super("This folder contains notes or subfolders. Move or delete them before deleting the folder.");
    this.name = "FolderNotEmptyError";
  }
}

export class FolderCycleError extends Error {
  constructor() {
    super("A folder cannot be moved inside itself or one of its descendants.");
    this.name = "FolderCycleError";
  }
}

export class DuplicateFolderNameError extends Error {
  constructor() {
    super("A folder with this name already exists in that location.");
    this.name = "DuplicateFolderNameError";
  }
}

export class MissingDocumentError extends Error {
  constructor() {
    super("Note not found.");
    this.name = "MissingDocumentError";
  }
}
