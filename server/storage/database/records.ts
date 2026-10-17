import { excerptFromMarkdown } from "../markdown.js";
import type { ChangeRecord, DocumentRecord, DocumentSummary, FolderRecord } from "../types.js";
import type { SqlRow } from "./context.js";

export function mapDocument(row: SqlRow): DocumentRecord {
  const body = String(row.body ?? "");
  return {
    id: String(row.id),
    title: String(row.title),
    folderId: row.folder_id === null || row.folder_id === undefined ? null : String(row.folder_id),
    ...(row.file_path ? { filePath: String(row.file_path) } : {}),
    ...(row.content_hash ? { contentHash: String(row.content_hash) } : {}),
    body,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
    excerpt: excerptFromMarkdown(body),
  };
}

export function mapSummary(row: SqlRow): DocumentSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    folderId: row.folder_id === null || row.folder_id === undefined ? null : String(row.folder_id),
    ...(row.file_path ? { filePath: String(row.file_path) } : {}),
    ...(row.content_hash ? { contentHash: String(row.content_hash) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
    excerpt: String(row.excerpt ?? ""),
  };
}

export function mapFolder(row: SqlRow): FolderRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    ...(row.file_path ? { filePath: String(row.file_path) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
    documentCount: Number(row.document_count ?? 0),
  };
}

export function mapChange(row: SqlRow): ChangeRecord {
  const entityType = row.entity_type === "folder" ? "folder" : "document";
  const change = {
    seq: Number(row.seq),
    title: String(row.title),
    operation: String(row.operation) as ChangeRecord["operation"],
    version: Number(row.version),
    createdAt: String(row.created_at),
  };
  return entityType === "folder"
    ? { ...change, entityType, folderId: String(row.document_id) }
    : { ...change, entityType, documentId: String(row.document_id) };
}
