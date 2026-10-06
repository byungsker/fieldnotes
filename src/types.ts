export type DocumentSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  excerpt: string;
};

export type DocumentRecord = DocumentSummary & { body: string };

export type ChangeRecord = {
  seq: number;
  documentId: string;
  title: string;
  operation: "created" | "updated" | "deleted";
  version: number;
  createdAt: string;
};

export type ApiErrorBody = { error?: string; message?: string; currentVersion?: number };
