import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeImageSource } from "../packages/markdown-live-editor";
import { remarkWikiLinks } from "./remark-wikilinks";
import { markdownBodyForPreview } from "./markdown-preview";
import type { DocumentSummary } from "./types";

type MarkdownBodyProps = {
  markdown: string;
  documents: DocumentSummary[];
  onOpenDocument: (id: string) => void;
};

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function MarkdownBody({ markdown, documents, onOpenDocument }: MarkdownBodyProps) {
  const byTitle = new Map(documents.map((document) => [normalizeTitle(document.title), document]));
  const previewMarkdown = markdownBodyForPreview(markdown);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        skipHtml
        urlTransform={(url, _key, node) => {
          if (node.tagName === "img") {
            const safeImage = safeImageSource(url);
            if (safeImage?.startsWith("data:image/")) return safeImage;
          }
          return url.startsWith("kb:") ? url : defaultUrlTransform(url);
        }}
        remarkPlugins={[remarkGfm, remarkWikiLinks]}
        components={{
          a({ href, children, ...props }) {
            if (href?.startsWith("kb:")) {
              let title = href.slice(3);
              try {
                title = decodeURIComponent(title);
              } catch {
                title = href.slice(3);
              }
              const target = byTitle.get(normalizeTitle(title));
              if (!target) {
                return (
                  <span className="wiki-missing">
                    {children}
                  </span>
                );
              }
              return (
                <a
                  className="wiki-link"
                  href={`#${target.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenDocument(target.id);
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a {...props} href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            const safeImage = typeof src === "string" ? safeImageSource(src) : null;
            if (!safeImage?.startsWith("data:image/")) {
              return <span className="markdown-image-placeholder">Image omitted: unsupported or unsafe source.</span>;
            }
            return <img src={safeImage} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />;
          },
        }}
      >
        {previewMarkdown}
      </ReactMarkdown>
    </div>
  );
}
