import { useEffect, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MarkdownLiveEditorAdapters } from "./types.ts";
import { safeHttpUrl, safeImageSource } from "./markdown-safety.ts";

interface MarkdownPreviewProps {
  frontmatter: string;
  body: string;
  adapters?: MarkdownLiveEditorAdapters;
}

function BookmarkPreviewCard({ url, adapters }: { url: string; adapters?: MarkdownLiveEditorAdapters }) {
  const [title, setTitle] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [siteName, setSiteName] = useState<string | null>(null);

  const fetchMetadata = adapters?.fetchBookmarkMetadata;

  useEffect(() => {
    const safeUrl = safeHttpUrl(url);
    if (!safeUrl || !fetchMetadata) return;
    const controller = new AbortController();
    void fetchMetadata(safeUrl, controller.signal).then((result) => {
      if (controller.signal.aborted || !result) return;
      setTitle(result.title);
      setDescription(result.description);
      setImage(result.image ? safeImageSource(result.image) : null);
      setSiteName(result.siteName);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [fetchMetadata, url]);

  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) return <span>{url}</span>;
  const hostname = new URL(safeUrl).hostname;

  return (
    <a className="mle-preview-bookmark" href={safeUrl} target="_blank" rel="noopener noreferrer">
      <span className="mle-preview-bookmark-copy">
        <strong>{title || hostname}</strong>
        {description && <span>{description}</span>}
        <small>{siteName || hostname}</small>
      </span>
      {image && <img src={image} alt={title || ""} loading="lazy" referrerPolicy="no-referrer" />}
    </a>
  );
}

function SafeLink({ href, children }: ComponentProps<"a">) {
  const safeUrl = href ? safeHttpUrl(href) : null;
  if (!safeUrl) return <span>{children}</span>;
  return <a href={safeUrl} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function SafeImage({ src, alt }: ComponentProps<"img">) {
  const safeSource = typeof src === "string" ? safeImageSource(src) : null;
  return safeSource ? <img src={safeSource} alt={alt || ""} loading="lazy" /> : <span>{alt || "Image omitted: unsafe source"}</span>;
}

function paragraphWithBookmark(adapters?: MarkdownLiveEditorAdapters) {
  return function PreviewParagraph({ children, ...props }: ComponentProps<"p">) {
    const nodes = (Array.isArray(children) ? children : [children]).filter(
      (child) => !(typeof child === "string" && child.trim() === "")
    ) as ReactNode[];
    const only = nodes.length === 1 ? nodes[0] : null;
    if (only && typeof only === "object" && "props" in only && only.type === SafeLink) {
      const link = only as ReactElement<ComponentProps<"a">>;
      if (typeof link.props.href === "string") {
        return <BookmarkPreviewCard url={link.props.href} adapters={adapters} />;
      }
    }
    return <p {...props}>{children}</p>;
  };
}

export function MarkdownPreview({ frontmatter, body, adapters }: MarkdownPreviewProps) {
  const PreviewParagraph = paragraphWithBookmark(adapters);

  return (
    <div className="mle-preview" aria-label="Markdown preview">
      {frontmatter && <pre className="mle-frontmatter" aria-label="Protected frontmatter">{frontmatter}</pre>}
      <div className="mle-preview-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: SafeLink,
            img: SafeImage,
            p: PreviewParagraph,
          }}
        >
          {body}
        </ReactMarkdown>
      </div>
    </div>
  );
}
