import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";

function PreservedMarkdownView({ node, deleteNode }: NodeViewProps) {
  const raw = typeof node.attrs.raw === "string" ? node.attrs.raw : "";

  return (
    <NodeViewWrapper className="mle-preserved-markdown" contentEditable={false}>
      <div className="mle-preserved-markdown-heading">
        <strong>Unsupported Markdown · preserved as source</strong>
        <button type="button" onClick={deleteNode}>Remove</button>
      </div>
      <p>This block stays unchanged while the surrounding Markdown remains editable.</p>
      <pre className="mle-preserved-markdown-source">{raw}</pre>
    </NodeViewWrapper>
  );
}

/** An explicit, inert source block for Markdown the rich schema cannot safely edit. */
export const PreservedMarkdown = Node.create({
  name: "preservedMarkdown",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { raw: { default: "" } };
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
    return ReactNodeViewRenderer(PreservedMarkdownView);
  },

  renderMarkdown: (node) => typeof node.attrs?.raw === "string" ? node.attrs.raw : "",
});

function PreservedWhitespaceView({ node }: NodeViewProps) {
  const raw = typeof node.attrs.raw === "string" ? node.attrs.raw : "";
  const lineCount = (raw.match(/\n/g) || []).length;
  const extraBlankLines = Math.max(0, lineCount - 2);
  return (
    <NodeViewWrapper
      as="div"
      className="mle-preserved-whitespace"
      aria-hidden="true"
      contentEditable={false}
      style={{ height: `${Math.min(extraBlankLines, 6)}em` }}
    />
  );
}

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
    return ReactNodeViewRenderer(PreservedWhitespaceView);
  },

  renderMarkdown: (node) => typeof node.attrs?.raw === "string" ? node.attrs.raw : "",
});
