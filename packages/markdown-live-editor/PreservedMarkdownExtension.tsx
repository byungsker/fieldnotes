import { mergeAttributes, Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createRoot, type Root } from "react-dom/client";
import { PreservedBlockPreview } from "./PreservedBlockPreview.tsx";
import type { MarkdownLiveEditorAdapters, MarkdownPreviewContext, PreservedBlockRenderer } from "./types.ts";

type PreservedMarkdownContext = MarkdownPreviewContext & { adapters?: MarkdownLiveEditorAdapters };
type PreservedMarkdownOptions = {
  getPreviewContext: () => PreservedMarkdownContext | undefined;
  renderPreview?: PreservedBlockRenderer;
};

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
    return ({ node, extension }) => {
      const dom = document.createElement("div");
      dom.className = "mle-preserved-markdown";
      dom.contentEditable = "false";

      const preview = document.createElement("div");
      preview.className = "mle-preserved-preview-mount";
      dom.append(preview);

      let previewRoot: Root | undefined;

      const render = (current: ProseMirrorNode) => {
        const raw = typeof current.attrs.raw === "string" ? current.attrs.raw : "";
        const context = extension.options.getPreviewContext();
        previewRoot ??= createRoot(preview);
        previewRoot.render(<PreservedBlockPreview raw={raw} context={context} renderPreservedBlock={extension.options.renderPreview} />);
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
