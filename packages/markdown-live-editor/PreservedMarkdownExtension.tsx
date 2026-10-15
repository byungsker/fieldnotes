import { mergeAttributes, Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createRoot, type Root } from "react-dom/client";
import { BabiesDataviewPreview, isSupportedBabyDataview, localImageReferences } from "./BabiesDataview.tsx";
import type { MarkdownLiveEditorAdapters, MarkdownPreviewContext } from "./types.ts";

type PreservedMarkdownContext = MarkdownPreviewContext & { adapters?: MarkdownLiveEditorAdapters };
type PreservedMarkdownOptions = { getPreviewContext: () => PreservedMarkdownContext | undefined };

function dataviewJsSource(raw: string): string | null {
  const lines = raw.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  const opening = lines[0]?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*dataviewjs(?:[ \t].*)?$/iu);
  const closing = lines.at(-1)?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u);
  if (!opening || !closing || opening[1]?.[0] !== closing[1]?.[0] || (closing[1]?.length ?? 0) < (opening[1]?.length ?? 0)) return null;
  return lines.slice(1, -1).join("\n");
}

function deleteNodeAt(editor: import("@tiptap/core").Editor, getPos: () => number | undefined, node: ProseMirrorNode) {
  const position = getPos();
  if (typeof position === "number") {
    editor.view.dispatch(editor.state.tr.delete(position, position + node.nodeSize));
  }
}

/** An explicit, inert source block for Markdown the rich schema cannot safely edit. */
export const PreservedMarkdown = Node.create<PreservedMarkdownOptions>({
  name: "preservedMarkdown",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { raw: { default: "" } };
  },

  addOptions() {
    return { getPreviewContext: () => undefined };
  },

  parseHTML() {
    return [{
      tag: "div[data-mle-preserved-markdown]",
      getAttrs: (element) => ({ raw: element.querySelector("pre")?.textContent || "" }),
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, {
      "data-mle-preserved-markdown": "",
    }), ["pre", {}, typeof node.attrs.raw === "string" ? node.attrs.raw : ""]];
  },

  addNodeView() {
    return ({ node, editor, getPos, extension }) => {
      const dom = document.createElement("div");
      dom.className = "mle-preserved-markdown";
      dom.contentEditable = "false";

      const heading = document.createElement("div");
      heading.className = "mle-preserved-markdown-heading";
      const label = document.createElement("strong");
      label.textContent = "Markdown source kept as-is";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => deleteNodeAt(editor, getPos, node));
      heading.append(label, remove);

      const details = document.createElement("details");
      details.className = "mle-preserved-markdown-details";
      const summary = document.createElement("summary");
      summary.textContent = "View preserved source";
      const source = document.createElement("pre");
      source.className = "mle-preserved-markdown-source";
      const preview = document.createElement("div");
      preview.className = "babies-preview-mount";
      const media = document.createElement("div");
      media.className = "babies-preview-attachments";
      details.append(summary, source);
      dom.append(heading, preview, media, details);

      let previewRoot: Root | undefined;

      const render = (current: ProseMirrorNode) => {
        const raw = typeof current.attrs.raw === "string" ? current.attrs.raw : "";
        source.textContent = raw;
        const context = extension.options.getPreviewContext();
        const code = dataviewJsSource(raw);
        const supported = Boolean(code && context && isSupportedBabyDataview(code, context));
        preview.hidden = !supported;
        const images = context?.documentPath?.startsWith("babies/") && context.documentId && context.adapters?.resolveVaultAsset
          ? localImageReferences(raw)
          : [];
        media.hidden = images.length === 0;
        media.replaceChildren();
        for (const imagePath of images) {
          const image = document.createElement("img");
          image.src = context?.adapters?.resolveVaultAsset?.(context.documentId ?? "", imagePath) ?? "";
          image.alt = imagePath.split("/").at(-1) || "Local attachment";
          image.loading = "lazy";
          image.referrerPolicy = "no-referrer";
          image.className = "babies-preview-attachment";
          media.append(image);
        }
        if (supported && code && context) {
          label.textContent = "Static baby view · script not run";
          summary.textContent = "View preserved DataviewJS source";
          previewRoot ??= createRoot(preview);
          previewRoot.render(<BabiesDataviewPreview source={code} context={context} adapters={context.adapters} />);
        } else if (images.length) {
          label.textContent = "Local attachments · original Markdown retained";
          summary.textContent = "View preserved Markdown source";
          previewRoot?.unmount();
          previewRoot = undefined;
          preview.replaceChildren();
        } else {
          label.textContent = "Markdown source kept as-is";
          summary.textContent = "View preserved source";
          previewRoot?.unmount();
          previewRoot = undefined;
          preview.replaceChildren();
        }
      };
      render(node);
      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type !== node.type) return false;
          node = updatedNode;
          render(updatedNode);
          return true;
        },
        destroy() {
          previewRoot?.unmount();
        },
      };
    };
  },

  renderMarkdown: (node) => typeof node.attrs?.raw === "string" ? node.attrs.raw : "",
});

/** Keeps exact source separators between independently editable Markdown blocks. */
export const PreservedWhitespace = Node.create({
  name: "preservedWhitespace",
  group: "block",
  atom: true,
  selectable: false,
  isolating: true,

  addAttributes() {
    return { raw: { default: "" } };
  },

  parseHTML() {
    return [{
      tag: "div[data-mle-preserved-whitespace]",
      getAttrs: (element) => ({ raw: element.getAttribute("data-source") || "" }),
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, {
      "data-mle-preserved-whitespace": "",
      "data-source": typeof node.attrs.raw === "string" ? node.attrs.raw : "",
    })];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "mle-preserved-whitespace";
      dom.setAttribute("aria-hidden", "true");
      dom.contentEditable = "false";
      const render = (current: ProseMirrorNode) => {
        const raw = typeof current.attrs.raw === "string" ? current.attrs.raw : "";
        const extraBlankLines = Math.max(0, (raw.match(/\n/g) || []).length - 2);
        dom.style.height = `${Math.min(extraBlankLines, 6)}em`;
      };
      render(node);
      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type !== node.type) return false;
          node = updatedNode;
          render(updatedNode);
          return true;
        },
      };
    };
  },

  renderMarkdown: (node) => typeof node.attrs?.raw === "string" ? node.attrs.raw : "",
});
