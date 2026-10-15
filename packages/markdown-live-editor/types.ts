import type { VisualizationAction, VisualizationQuery, VisualizationQueryResponse } from "../../shared/visualization.ts";

export interface BookmarkMetadata {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
}

export interface EditorSnippet {
  id: string;
  name: string;
  content: string;
  shortcut?: string | null;
}

export interface NewEditorSnippet {
  id?: string;
  name: string;
  content: string;
  shortcut?: string | null;
}

export interface PreviewDocument {
  id: string;
  title: string;
  filePath?: string;
  updatedAt?: string;
  body?: string;
}

export interface MarkdownPreviewContext {
  documentId?: string;
  documentPath?: string;
  recordsFolderId?: string;
  onOpenDocument?: (documentId: string) => void;
}

export interface MarkdownLiveEditorAdapters {
  uploadImage?: (file: File) => Promise<string>;
  fetchBookmarkMetadata?: (url: string, signal: AbortSignal) => Promise<BookmarkMetadata | null>;
  listSnippets?: () => Promise<EditorSnippet[]>;
  saveSnippet?: (snippet: NewEditorSnippet) => Promise<EditorSnippet>;
  deleteSnippet?: (id: string) => Promise<void>;
  queryVisualization?: (query: VisualizationQuery, signal: AbortSignal) => Promise<VisualizationQueryResponse>;
  executeVisualizationAction?: (action: VisualizationAction) => Promise<Record<string, unknown>>;
  subscribeToVaultChanges?: (onChange: () => void) => () => void;
  enableCustomVisualizations?: boolean;
  isVisualizationTrusted?: (documentId: string, blockIndex: number, sourceHash: string) => boolean;
  trustVisualization?: (documentId: string, blockIndex: number, sourceHash: string) => void;
  revokeVisualizationTrust?: (documentId: string, blockIndex: number, sourceHash: string) => void;
  loadBabyPreviewDocuments?: (signal: AbortSignal) => Promise<PreviewDocument[]>;
  createPreviewDocument?: (input: { title: string; body: string; folderId: string }) => Promise<PreviewDocument>;
  resolveVaultAsset?: (documentId: string, source: string) => string;
}

export interface MarkdownLiveEditorProps {
  value: string;
  onChange: (value: string) => void;
  adapters?: MarkdownLiveEditorAdapters;
  previewContext?: MarkdownPreviewContext;
  ariaLabel?: string;
  minHeight?: number | string;
  /** Hide document action controls while keeping the editable document surface. */
  showToolbar?: boolean;
  /** Hide the built-in outline when the host renders its own table of contents. */
  showOutline?: boolean;
  onFocus?: () => void;
  /** Reports an unexpected serializer failure so the host can keep an unsafe draft from being saved. */
  onSerializationSafetyChange?: (safe: boolean) => void;
  visualizationDocumentId?: string;
  openVisualizationNote?: (noteId: string) => Promise<void>;
}
