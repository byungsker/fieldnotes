export type DocumentSummary = {
  id: string;
  title: string;
  folderId: string | null;
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

export type ApiErrorBody = { error?: string; message?: string; currentVersion?: number };
