import React, { type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { resolveLocalImageAssetPath } from "./local-image-path.ts";
import { safeHttpUrl } from "./markdown-safety.ts";
import type { MarkdownLiveEditorAdapters, MarkdownPreviewContext } from "./types.ts";

void React;

interface PreservedMarkdownPreviewProps {
  raw: string;
  context?: MarkdownPreviewContext & { adapters?: MarkdownLiveEditorAdapters };
}

interface PreviewSource {
  markdown: string;
  hasUnrenderedScript: boolean;
  hasUnrenderedHtml: boolean;
}

function stripHtmlForPreviewLine(line: string, state: { hiddenTag: string | null; hiddenComment: boolean }) {
  let cursor = 0;
  let visible = "";
  let hasHtml = false;

  if (state.hiddenComment) {
    const commentEnd = line.indexOf("-->");
    if (commentEnd < 0) return { line: "", hasHtml: true };
    cursor = commentEnd + 3;
    state.hiddenComment = false;
    hasHtml = true;
  }
  if (state.hiddenTag) {
    const close = new RegExp(`<\\/${state.hiddenTag}\\s*>`, "iu").exec(line.slice(cursor));
    if (!close) return { line: "", hasHtml: true };
    cursor += close.index + close[0].length;
    state.hiddenTag = null;
    hasHtml = true;
  }

  while (cursor < line.length) {
    const rest = line.slice(cursor);
    if (rest.startsWith("<!--")) {
      const commentEnd = line.indexOf("-->", cursor + 4);
      hasHtml = true;
      if (commentEnd < 0) {
        state.hiddenComment = true;
        break;
      }
      cursor = commentEnd + 3;
      continue;
    }

    if (rest[0] === "`") {
      const delimiter = rest.match(/^`+/u)?.[0];
      if (delimiter) {
        const closing = line.indexOf(delimiter, cursor + delimiter.length);
        if (closing >= 0) {
          const end = closing + delimiter.length;
          visible += line.slice(cursor, end);
          cursor = end;
          continue;
        }
      }
    }

    const markdownImage = rest.match(/^!\[[^\]\r\n]*\]\(\s*<[^>\r\n]+>(?:[ \t]+[^)]*)?\)/u);
    if (markdownImage) {
      visible += markdownImage[0];
      cursor += markdownImage[0].length;
      continue;
    }

    const activeTag = rest.match(/^<(script|iframe|object|embed|style)\b[^>]*>/iu);
    if (activeTag) {
      const tagName = activeTag[1] ?? "script";
      const bodyStart = cursor + activeTag[0].length;
      const close = new RegExp(`<\\/${tagName}\\s*>`, "iu").exec(line.slice(bodyStart));
      hasHtml = true;
      if (!close) {
        state.hiddenTag = tagName;
        break;
      }
      cursor = bodyStart + close.index + close[0].length;
      continue;
    }

    const tag = rest.match(/^<\/?[a-z][a-z0-9-]*(?:[ \t]+[^<>]*|\/?)>/iu);
    if (tag) {
      hasHtml = true;
      cursor += tag[0].length;
      continue;
    }

    visible += line[cursor] ?? "";
    cursor += 1;
  }

  return { line: visible, hasHtml };
}

function preparePreviewSource(raw: string, documentPath?: string): PreviewSource {
  const lines = raw.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  const output: string[] = [];
  const htmlState = { hiddenTag: null as string | null, hiddenComment: false };
  let fence: { marker: string; length: number; omit: boolean } | null = null;
  let hasUnrenderedScript = false;
  let hasUnrenderedHtml = false;

  for (const line of lines) {
    if (!fence) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`~]+)?(?:[ \t].*)?$/u);
      if (opening) {
        const language = (opening[2] ?? "").toLowerCase();
        const omit = language === "dataviewjs";
        fence = { marker: opening[1]?.[0] ?? "`", length: opening[1]?.length ?? 3, omit };
        if (omit) hasUnrenderedScript = true;
        if (!omit) output.push(line);
        continue;
      }
    } else {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u);
      if (closing && closing[1]?.[0] === fence.marker && (closing[1]?.length ?? 0) >= fence.length) {
        if (!fence.omit) output.push(line);
        fence = null;
        continue;
      }
      if (!fence.omit) output.push(line);
      continue;
    }

    const imagePrepared = documentPath
      ? line.replace(/!\[\[([^\]\r\n]+)\]\]/gu, (_whole, rawTarget: string) => {
        const target = rawTarget.split("|", 1)[0]?.trim() ?? "";
        const assetPath = resolveLocalImageAssetPath(target, documentPath);
        if (!assetPath) return "![Image omitted: unsupported or unsafe source](fieldnotes-unsafe-image:omitted)";
        const alt = assetPath.split("/").at(-1) || "Local attachment";
        const encodedAssetPath = assetPath.split("/").map(encodeURIComponent).join("/");
        return `![${alt}](/${encodedAssetPath})`;
      })
      : line;
    const safeLine = stripHtmlForPreviewLine(imagePrepared, htmlState);
    output.push(safeLine.line);
    hasUnrenderedHtml ||= safeLine.hasHtml;
  }

  const markdown = output.join("\n");
  return {
    markdown,
    hasUnrenderedScript,
    hasUnrenderedHtml,
  };
}

function SafeLink({ href, children }: ComponentProps<"a">) {
  const safeUrl = href ? safeHttpUrl(href) : null;
  return safeUrl
    ? <a href={safeUrl} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>;
}

function LocalImage({ src, alt, context }: ComponentProps<"img"> & { context?: PreservedMarkdownPreviewProps["context"] }) {
  const documentPath = context?.documentPath;
  const documentId = context?.documentId;
  const documentHash = context?.documentHash;
  const resolveAsset = context?.adapters?.resolveReferencedVaultAsset;
  let decodedSource: string | null = null;
  if (typeof src === "string") {
    try { decodedSource = decodeURIComponent(src); }
    catch { decodedSource = null; }
  }
  const assetPath = decodedSource && documentPath
    ? resolveLocalImageAssetPath(decodedSource, documentPath)
    : null;

  if (!assetPath) {
    return <span className="mle-preserved-warning" role="note">Image omitted: unsupported or unsafe source.</span>;
  }
  if (!documentId || !documentHash || !resolveAsset) {
    return <span className="mle-preserved-warning" role="note">Local image preview is unavailable.</span>;
  }

  return (
    <img
      src={resolveAsset(documentId, assetPath, documentHash)}
      alt={alt || "Local attachment"}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}

export function PreservedMarkdownPreview({ raw, context }: PreservedMarkdownPreviewProps) {
  const prepared = preparePreviewSource(raw, context?.documentPath);
  return (
    <div className="mle-preserved-preview">
      {prepared.markdown.trim() && (
        <div className="mle-preview-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: SafeLink,
              img: (props) => <LocalImage {...props} context={context} />,
            }}
          >
            {prepared.markdown}
          </ReactMarkdown>
        </div>
      )}
      {prepared.hasUnrenderedScript && (
        <p className="mle-preserved-warning" role="note">DataviewJS is preserved and was not run.</p>
      )}
      {prepared.hasUnrenderedHtml && (
        <p className="mle-preserved-warning" role="note">Embedded HTML is preserved but not rendered in this preview.</p>
      )}
    </div>
  );
}
