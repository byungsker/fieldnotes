import React from "react";
import type { PreservedBlockRenderer } from "../../../../packages/markdown-live-editor";
import type { BabiesPreviewAdapters } from "../model/baby-preview";
import { BabiesDataviewPreview } from "./BabiesDataview";
import { isSupportedBabyDataview } from "../model/baby-records";

void React;

function dataviewJsSource(raw: string): string | null {
  const lines = raw.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  const opening = lines[0]?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*dataviewjs(?:[ \t].*)?$/iu);
  const closing = lines.at(-1)?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u);
  if (!opening || !closing || opening[1]?.[0] !== closing[1]?.[0] || (closing[1]?.length ?? 0) < (opening[1]?.length ?? 0)) return null;
  return lines.slice(1, -1).join("\n");
}

export function createBabiesPreservedBlockRenderer(adapters: BabiesPreviewAdapters): PreservedBlockRenderer {
  return (raw, context) => {
    const source = dataviewJsSource(raw);
    return source !== null && isSupportedBabyDataview(source, context)
      ? <BabiesDataviewPreview source={source} context={context} adapters={adapters} />
      : null;
  };
}
