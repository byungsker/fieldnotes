# Markdown Live Editor

A reusable controlled Markdown editor for React 19. It accepts Markdown as a string and keeps persistence, image handling, bookmark metadata, and snippets behind injected adapters.

## Public API

```tsx
import { MarkdownLiveEditor, type MarkdownLiveEditorAdapters } from "markdown-live-editor";
import "markdown-live-editor/styles.css";

const adapters: MarkdownLiveEditorAdapters = {
  uploadImage: (file) => applicationApi.uploadImage(file),
  fetchBookmarkMetadata: (url, signal) => applicationApi.fetchBookmarkMetadata(url, signal),
  listSnippets: () => applicationApi.listSnippets(),
  saveSnippet: (snippet) => applicationApi.saveSnippet(snippet),
  deleteSnippet: (id) => applicationApi.deleteSnippet(id),
};

<MarkdownLiveEditor
  value={markdown}
  onChange={setMarkdown}
  adapters={adapters}
  ariaLabel="Note body"
  minHeight={460}
  onFocus={() => setEditorFocused(true)}
  showPreviewTab={false}
/>
```

All adapter functions are optional. No adapter means no upload, metadata lookup, or snippet persistence. The package does not choose endpoints, fetch remote URLs itself, store data, authenticate users, or depend on a host framework. `showPreviewTab` defaults to `true`; set it to `false` when the host supplies its own preview and navigation.

## Included behavior

- TipTap rich text editing with StarterKit, separately configured Lowlight code blocks, safe HTTP/HTTPS links, and image upload through an injected adapter.
- Cmd/Ctrl+K opens a structured link editor. The command inserts ProseMirror text/mark nodes and never interpolates HTML.
- Safe bookmark URL cards with optional adapter-provided metadata and a URL dialog in the toolbar. A standalone HTTP(S) URL is represented in Markdown by that same URL line.
- A visible heading outline, snippet save/edit/delete/insert UI, snippet keyboard shortcuts, placeholder text, code block language selection, and write/preview views. Hosts can hide the view tabs while keeping the rich editor directly visible.
- Image attachments go through the host adapter. The toolbar preserves the selected insertion point, including when a bookmark card is selected.
- Preview through `react-markdown` and GitHub Flavored Markdown. Raw HTML is not enabled. Link and image sources are checked before rendering.
- Supported `[[target]]`, `[[target#fragment]]`, `[[target|alias]]`, and `[[target#fragment|alias]]` forms use atomic wikilink nodes and serialize to their exact original token. A source textarea fallback is used when parsing and serialization change Markdown content or document structure.
- A closed leading YAML frontmatter block is removed from the editable body and preserved byte-for-byte as a protected prefix, including its line endings and BOM. Write mode shows a preserved-frontmatter badge; preview and source fallback display the protected block separately. Host document properties remain independent of that prefix.

The Markdown extension is the official `@tiptap/markdown` 3.31.4 package. It is still marked beta by its maintainers and does not promise support for every Markdown dialect. On load, this component checks that parsing and serialization preserve both the parsed document tree and all source text. It allows a different blank-line count only at a plain ATX heading-to-block boundary, such as a heading followed by a paragraph with one newline instead of two. Paragraph spacing and source within code fences, lists, HTML blocks, and hard breaks remain exact; other changes use source editing. An untouched note body is not rewritten on load; after an edit, the serializer may canonicalize heading-to-block spacing. Uniform LF and CRLF are supported and restored; mixed LF/CRLF and bare-CR input use source mode. The rich editor supports a deliberate Markdown subset rather than claiming full Obsidian compatibility. Wikilink nodes retain the raw token while the host provides title resolution and navigation in its own preview.

In controlled use, an echo of the editor's own latest value does not reset the ProseMirror document or selection. Content-preservation checks wait until IME composition and Markdown input rules settle; a stable content or structure mismatch switches to source mode while preserving keyboard focus.

The `minHeight` prop accepts pixels as a number or any valid CSS length string. The stylesheet uses `.mle-*` classes and `--mle-*` custom properties so a host can override presentation without inheriting application branding.

## Local development

This component is designed to be embedded in a host React app. The host owns the API and must supply adapters for any persistence or network access. The Markdown body remains the only editor storage contract; the package does not parse or rewrite application databases. The `examples/ControlledEditor.tsx` file shows the minimal controlled setup.

For package checks, install the pinned dependencies and run `npm test` and `npm run typecheck`. This repository does not publish the package to npm; consumers can install it from a Git dependency or vendor it into their app.

## Attribution and notices

The included editor is generic and contains no host application branding or assets. Third-party license notes are in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
