export type DocumentSummary = {
  id: string;
  title: string;
  folderId: string | null;
  /** Relative path from the configured Markdown vault root; empty in SQLite-only mode. */
  filePath?: string;
  /** SHA-256 of the exact UTF-8 Markdown file bytes in filesystem mode. */
  contentHash?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  excerpt: string;
};

export type DocumentRecord = DocumentSummary & { body: string };

export type FolderRecord = {
  id: string;
  name: string;
  parentId: string | null;
  /** Relative directory path from the configured Markdown vault root. */
  filePath?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  documentCount: number;
};

export type ChangeRecord = {
  seq: number;
  entityType: "document" | "folder";
  documentId?: string;
  folderId?: string;
  title: string;
  operation: "created" | "updated" | "deleted";
  version: number;
  createdAt: string;
};
