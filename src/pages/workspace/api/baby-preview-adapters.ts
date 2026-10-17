import { apiRequest } from "../../../shared/api";
import type { PreviewDocument } from "../../../../packages/markdown-live-editor";
import type { BabiesPreviewAdapters } from "../model/baby-preview";

export function createBabiesPreviewAdapters(): BabiesPreviewAdapters {
  return {
    async loadBabyPreviewDocuments(signal): Promise<PreviewDocument[]> {
      const result = await apiRequest<{ documents: PreviewDocument[] }>("/api/preview/babies", { signal });
      return result.documents;
    },
    async createPreviewDocument(input) {
      const result = await apiRequest<{ document: PreviewDocument }>("/api/documents", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return result.document;
    },
    resolveVaultAsset(documentId, source) {
      const query = new URLSearchParams({ documentId, source });
      return `/api/preview/babies/asset?${query.toString()}`;
    },
  };
}
