import { mergeAttributes, Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

function deleteNodeAt(editor: import("@tiptap/core").Editor, getPos: () => number | undefined, node: ProseMirrorNode) {
  const position = getPos();
  if (typeof position === "number") {
    editor.view.dispatch(editor.state.tr.delete(position, position + node.nodeSize));
  }
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
    return ({ node, editor, getPos }) => {
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
      summary.textContent = "View preserved text";
      const source = document.createElement("pre");
      source.className = "mle-preserved-markdown-source";
      details.append(summary, source);
      dom.append(heading, details);

      const render = (current: ProseMirrorNode) => {
        source.textContent = typeof current.attrs.raw === "string" ? current.attrs.raw : "";
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
