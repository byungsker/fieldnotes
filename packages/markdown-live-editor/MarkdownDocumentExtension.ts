import { Node } from "@tiptap/core";

/** Render exact separators stored by the Markdown preservation parser. */
export const MarkdownDocument = Node.create({
  name: "doc",
  topNode: true,
  content: "block+",

  renderMarkdown: (node, helpers) => {
    const content = Array.isArray(node.content) ? node.content : [];
    let markdown = "";

    content.forEach((child, index) => {
      markdown += helpers.renderChild?.(child, index) ?? helpers.renderChildren([child], "");
      const next = content[index + 1];
      if (next && child.type !== "preservedWhitespace" && next.type !== "preservedWhitespace") {
        markdown += "\n\n";
      }
    });

    return markdown;
  },
});
