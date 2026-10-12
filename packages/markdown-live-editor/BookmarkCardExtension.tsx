import { Node, mergeAttributes, type NodeViewRendererProps } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { safeHttpUrl, safeImageSource, isStandaloneWebUrl } from "./markdown-safety.ts";
import type { BookmarkMetadata, MarkdownLiveEditorAdapters } from "./types.ts";

interface BookmarkCardOptions {
  fetchBookmarkMetadata?: MarkdownLiveEditorAdapters["fetchBookmarkMetadata"];
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    bookmarkCard: {
      insertBookmarkCard: (options: { url: string }) => ReturnType;
    };
  }
}

function bookmarkNodeView({ node: initialNode, editor, getPos, extension }: NodeViewRendererProps) {
  let node: ProseMirrorNode = initialNode;
  let metadata: BookmarkMetadata | null = null;
  let loading = false;
  let failed = false;
  let controller: AbortController | null = null;
  const rawUrl = () => typeof node.attrs.url === "string" ? node.attrs.url : "";
  const url = () => safeHttpUrl(rawUrl());
  const dom = document.createElement("div");
  dom.className = "mle-bookmark-card";
  dom.contentEditable = "false";
  const link = document.createElement("a");
  link.className = "mle-bookmark-card-link";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const copy = document.createElement("span");
  copy.className = "mle-bookmark-card-copy";
  const title = document.createElement("strong");
  const description = document.createElement("span");
  const meta = document.createElement("small");
  copy.append(title, description, meta);
  const invalidLabel = document.createElement("span");
  invalidLabel.textContent = "Unsafe bookmark URL preserved as text.";
  invalidLabel.hidden = true;
  const image = document.createElement("img");
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  link.append(copy, image);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "mle-bookmark-card-remove";
  remove.setAttribute("aria-label", "Remove bookmark card");
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    const position = getPos();
    if (typeof position === "number") editor.view.dispatch(editor.state.tr.delete(position, position + node.nodeSize));
  });
  dom.append(link, remove);

  const render = () => {
    const safeUrl = url();
    if (!safeUrl) {
      dom.classList.add("mle-bookmark-card-invalid");
      link.removeAttribute("href");
      title.hidden = true;
      description.hidden = true;
      meta.hidden = true;
      invalidLabel.hidden = false;
      copy.prepend(invalidLabel);
      image.hidden = true;
      remove.hidden = true;
      return;
    }
    dom.classList.remove("mle-bookmark-card-invalid");
    invalidLabel.remove();
    title.hidden = false;
    meta.hidden = false;
    remove.hidden = false;
    link.href = safeUrl;
    const hostname = new URL(safeUrl).hostname;
    title.textContent = metadata?.title || hostname;
    description.textContent = metadata?.description || "";
    description.hidden = !metadata?.description;
    meta.textContent = `${metadata?.siteName || hostname}${loading ? " · Loading preview" : failed ? " · Preview unavailable" : ""}`;
    const imageUrl = metadata?.image ? safeImageSource(metadata.image) : null;
    if (imageUrl) {
      image.src = imageUrl;
      image.alt = metadata?.title || "";
      image.hidden = false;
    } else {
      image.removeAttribute("src");
      image.hidden = true;
    }
  };
  const loadMetadata = () => {
    controller?.abort();
    controller = null;
    metadata = null;
    failed = false;
    const safeUrl = url();
    const fetchMetadata = (extension.options as BookmarkCardOptions).fetchBookmarkMetadata;
    loading = Boolean(safeUrl && fetchMetadata);
    render();
    if (!safeUrl || !fetchMetadata) return;
    const requestController = new AbortController();
    controller = requestController;
    void fetchMetadata(safeUrl, requestController.signal)
      .then((result) => { if (!requestController.signal.aborted && result) metadata = result; })
      .catch(() => { if (!requestController.signal.aborted) failed = true; })
      .finally(() => {
        if (requestController.signal.aborted) return;
        loading = false;
        render();
      });
  };
  loadMetadata();
  return {
    dom,
    update(updatedNode: ProseMirrorNode) {
      if (updatedNode.type !== node.type) return false;
      const urlChanged = updatedNode.attrs.url !== node.attrs.url;
      node = updatedNode;
      if (urlChanged) loadMetadata();
      return true;
    },
    destroy() { controller?.abort(); },
  };
}

export const BookmarkCard = Node.create<BookmarkCardOptions>({
  name: "bookmarkCard",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { fetchBookmarkMetadata: undefined };
  },

  addAttributes() {
    return { url: { default: null } };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-mle-bookmark-card]",
        getAttrs: (element) => {
          const url = element.getAttribute("data-url") || "";
          return safeHttpUrl(url) ? { url } : false;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const url = safeHttpUrl(typeof node.attrs.url === "string" ? node.attrs.url : "");
    if (!url) return ["span", { "data-mle-invalid-bookmark": "" }, "Invalid bookmark URL"];
    return ["div", mergeAttributes(HTMLAttributes, { "data-mle-bookmark-card": "", "data-url": url })];
  },

  addNodeView() {
    return bookmarkNodeView;
  },

  addCommands() {
    return {
      insertBookmarkCard:
        ({ url }) =>
        ({ commands }) => {
          const safeUrl = safeHttpUrl(url);
          return safeUrl ? commands.insertContent({ type: this.name, attrs: { url: safeUrl } }) : false;
        },
    };
  },

  markdownTokenizer: {
    name: "bookmarkCard",
    level: "block",
    start: (source) => {
      const http = source.indexOf("http://");
      const https = source.indexOf("https://");
      if (http < 0) return https;
      if (https < 0) return http;
      return Math.min(http, https);
    },
    tokenize: (source) => {
      const match = /^(https?:\/\/[^\s<>]+)(?:[ \t]*\r?\n|$)/i.exec(source);
      if (!match || !isStandaloneWebUrl(match[1])) return undefined;
      return { type: "bookmarkCard", raw: match[0], url: match[1] };
    },
  },

  parseMarkdown: (token) => {
    const url = typeof token.url === "string" ? safeHttpUrl(token.url) : null;
    return url
      ? { type: "bookmarkCard", attrs: { url } }
      : { type: "paragraph", content: [{ type: "text", text: String(token.url || token.raw || "") }] };
  },

  renderMarkdown: (node) => {
    const url = typeof node.attrs?.url === "string" ? safeHttpUrl(node.attrs.url) : null;
    return url || "";
  },

  addProseMirrorPlugins() {
    const nodeType = this.type;
    return [
      new Plugin({
        key: new PluginKey("mleBookmarkCardPaste"),
        props: {
          handlePaste(view, event) {
            const text = event.clipboardData?.getData("text/plain")?.trim() || "";
            const url = safeHttpUrl(text);
            if (!url || !isStandaloneWebUrl(text) || !view.state.selection.empty) return false;
            view.dispatch(view.state.tr.replaceSelectionWith(nodeType.create({ url })));
            return true;
          },
        },
      }),
    ];
  },
});
