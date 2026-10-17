import React from "react";
import { PreservedMarkdownPreview } from "./PreservedMarkdownPreview.tsx";
import type { MarkdownLiveEditorAdapters, MarkdownPreviewContext, PreservedBlockRenderer } from "./types.ts";

void React;

export function PreservedBlockPreview({ raw, context, renderPreservedBlock }: {
  raw: string;
  context?: MarkdownPreviewContext & { adapters?: MarkdownLiveEditorAdapters };
  renderPreservedBlock?: PreservedBlockRenderer;
}) {
  return renderPreservedBlock?.(raw, context ?? {}) ?? <PreservedMarkdownPreview raw={raw} context={context} />;
}
