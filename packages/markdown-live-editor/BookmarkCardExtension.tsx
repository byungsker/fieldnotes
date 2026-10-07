import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { useEffect, useState } from "react";
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

function BookmarkCardView({ node, deleteNode, extension }: NodeViewProps) {
  const rawUrl = typeof node.attrs.url === "string" ? node.attrs.url : "";
  const url = safeHttpUrl(rawUrl);
  const [metadata, setMetadata] = useState<BookmarkMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const fetchMetadata = (extension.options as BookmarkCardOptions).fetchBookmarkMetadata;

  useEffect(() => {
    setMetadata(null);
    setFailed(false);
    if (!url || !fetchMetadata) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    void fetchMetadata(url, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && result) setMetadata(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [fetchMetadata, url]);

  const hostname = url ? new URL(url).hostname : rawUrl;
  const image = metadata?.image ? safeImageSource(metadata.image) : null;

  if (!url) {
    return (
      <NodeViewWrapper className="mle-bookmark-card mle-bookmark-card-invalid" contentEditable={false}>
        <span>Unsafe bookmark URL preserved as text.</span>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="mle-bookmark-card" contentEditable={false}>
      <a className="mle-bookmark-card-link" href={url} target="_blank" rel="noopener noreferrer">
        <span className="mle-bookmark-card-copy">
          <strong>{metadata?.title || hostname}</strong>
          {metadata?.description && <span>{metadata.description}</span>}
          <small>{metadata?.siteName || hostname}{loading ? " · Loading preview" : failed ? " · Preview unavailable" : ""}</small>
        </span>
        {image && <img src={image} alt={metadata?.title || ""} loading="lazy" referrerPolicy="no-referrer" />}
      </a>
      <button type="button" className="mle-bookmark-card-remove" onClick={deleteNode} aria-label="Remove bookmark card">
        ×
      </button>
    </NodeViewWrapper>
  );
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
    return ReactNodeViewRenderer(BookmarkCardView);
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
