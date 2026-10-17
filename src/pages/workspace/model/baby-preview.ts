import type { PreviewDocument } from "../../../../packages/markdown-live-editor";

export interface BabiesPreviewAdapters {
  loadBabyPreviewDocuments?: (signal: AbortSignal) => Promise<PreviewDocument[]>;
  createPreviewDocument?: (input: { title: string; body: string; folderId: string }) => Promise<PreviewDocument>;
  resolveVaultAsset?: (documentId: string, source: string) => string;
}
