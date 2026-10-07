import { useState } from "react";
import { MarkdownLiveEditor } from "markdown-live-editor";
import "markdown-live-editor/styles.css";

export function ControlledEditorExample() {
  const [markdown, setMarkdown] = useState("# A note\n\nWrite Markdown here.");
  return <MarkdownLiveEditor value={markdown} onChange={setMarkdown} ariaLabel="Example note body" />;
}
