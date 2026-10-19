import type { ChangeRecord, DocumentRecord, FolderRecord } from "../types.js";
import { STATE_FORMAT, STATE_VERSION } from "./constants.js";

export type FileKey = { device: string; inode: string };

export type VaultDocumentMeta = FileKey & {
  id: string;
  title: string;
  folderId: string | null;
  relativePath: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  contentHash: string;
};

export type VaultTrashMeta = VaultDocumentMeta & { trashPath: string; trashedAt: string };

export type VaultFolderMeta = FileKey & {
  id: string;
  name: string;
  parentId: string | null;
  relativePath: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

type PendingBase = { change: ChangeRecord };

export type PendingOperation = PendingBase & (
  | { kind: "document-create"; next: Omit<VaultDocumentMeta, keyof FileKey>; tempPath: string }
  | { kind: "document-update"; next: Omit<VaultDocumentMeta, keyof FileKey>; oldPath: string; oldHash: string; tempPath: string }
  | { kind: "document-delete"; id: string; title: string; oldPath: string; oldHash: string; nextVersion: number }
  | { kind: "document-trash"; id: string; oldPath: string; oldHash: string; trashPath: string; trashedAt: string; nextVersion: number }
  | { kind: "document-restore"; id: string; trashPath: string; next: Omit<VaultDocumentMeta, keyof FileKey>; change: ChangeRecord }
  | { kind: "folder-create"; next: Omit<VaultFolderMeta, keyof FileKey> }
  | { kind: "folder-update"; next: Omit<VaultFolderMeta, keyof FileKey>; oldPath: string; tempPath?: string }
  | { kind: "folder-delete"; id: string; name: string; oldPath: string; nextVersion: number }
);

export type VaultState = {
  format: typeof STATE_FORMAT;
  schemaVersion: typeof STATE_VERSION;
  vaultId: string;
  sequence: number;
  documents: VaultDocumentMeta[];
  trashedDocuments: VaultTrashMeta[];
  folders: VaultFolderMeta[];
  changes: ChangeRecord[];
  pending?: PendingOperation;
};

export type VaultSnapshot = {
  vaultId: string;
  sequence: number;
  documents: DocumentRecord[];
  folders: FolderRecord[];
  changes: ChangeRecord[];
};

export type VaultDocumentReadResult = {
  document?: DocumentRecord;
  changes: ChangeRecord[];
  fullReconcile: boolean;
};

export type LegacyDocument = {
  id: string;
  title: string;
  body: string;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type LegacyTrashedDocument = LegacyDocument & { trashedAt: string };

export type LegacyFolder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type ScannedFolder = FileKey & { name: string; relativePath: string; parentPath: string };

export type ScannedDocument = FileKey & {
  name: string;
  relativePath: string;
  parentPath: string;
  body: string;
  contentHash: string;
  byteLength: number;
};
