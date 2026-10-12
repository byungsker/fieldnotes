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
}

export interface MarkdownLiveEditorProps {
  value: string;
  onChange: (value: string) => void;
  adapters?: MarkdownLiveEditorAdapters;
  ariaLabel?: string;
  minHeight?: number | string;
  onFocus?: () => void;
  /** Reports an unexpected serializer failure so the host can keep an unsafe draft from being saved. */
  onSerializationSafetyChange?: (safe: boolean) => void;
  visualizationDocumentId?: string;
  openVisualizationNote?: (noteId: string) => Promise<void>;
}
