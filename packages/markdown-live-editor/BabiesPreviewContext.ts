import { createContext } from "react";
import type { PreviewDocument } from "./types.ts";

export type BabiesPreviewState = { documents: PreviewDocument[]; loading: boolean; error: boolean };

export const BabiesPreviewDocumentsContext = createContext<BabiesPreviewState>({
  documents: [],
  loading: false,
  error: false,
});
