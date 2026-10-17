import { createContext } from "react";
import type { PreviewDocument } from "../../../../packages/markdown-live-editor";

export type BabiesPreviewState = { documents: PreviewDocument[]; loading: boolean; error: boolean };

export const BabiesPreviewDocumentsContext = createContext<BabiesPreviewState>({
  documents: [],
  loading: false,
  error: false,
});
