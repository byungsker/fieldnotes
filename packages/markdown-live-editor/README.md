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
  onSerializationSafetyChange={(safe) => setCanSave(safe)}
/>
```

All adapter functions are optional. No adapter means no upload, metadata lookup, or snippet persistence. The package does not choose endpoints, fetch remote URLs itself, store data, authenticate users, or depend on a host framework. The editor presents one rich editing surface without a source textarea or Write/Preview mode switch.

## Included behavior

- TipTap rich text editing with StarterKit, separately configured Lowlight code blocks, safe HTTP/HTTPS links, and image upload through an injected adapter.
- Cmd/Ctrl+K opens a structured link editor. The command inserts ProseMirror text/mark nodes and never interpolates HTML.
- Safe bookmark URL cards with optional adapter-provided metadata and a URL dialog in the toolbar. A standalone HTTP(S) URL is represented in Markdown by that same URL line.
- A visible heading outline, snippet save/edit/delete/insert UI, snippet keyboard shortcuts, placeholder text, and code block language selection. Text formatting stays available through Markdown input rules and keyboard shortcuts; the editor toolbar keeps document actions such as code blocks, links, bookmarks, images, outline, and snippets.
- Image attachments go through the host adapter. The toolbar preserves the selected insertion point, including when a bookmark card is selected.
- Preview through `react-markdown` and GitHub Flavored Markdown. Raw HTML is not enabled. Link and image sources are checked before rendering.
- Supported `[[target]]`, `[[target#fragment]]`, `[[target|alias]]`, and `[[target#fragment|alias]]` forms use atomic wikilink nodes and serialize to their exact original token. If a Markdown block changes under the parser/serializer, it appears as a clearly labeled read-only preservation card containing its original text. Neighboring supported blocks remain editable and saving preserves the card's source exactly. Remove is an explicit action on the card.
- Plain-text Markdown paste uses the same preservation parser, so unsupported blocks are inserted as read-only cards rather than held in the clipboard. The same parser handles initial loads, external updates, and snippets.
- A closed leading YAML frontmatter block and its following blank separator lines are removed from the editable body and preserved byte-for-byte as a protected prefix, including their line endings and BOM. The editor shows a preserved-frontmatter badge. Host document properties remain independent of that prefix.

The Markdown extension is the official `@tiptap/markdown` 3.31.4 package. It is still marked beta by its maintainers and does not promise support for every Markdown dialect. The editor checks each block before displaying it as rich content. Blocks the editor cannot round-trip exactly become read-only preservation cards, including a whole-note card if parsing cannot safely segment the document. Mixed LF/CRLF or bare-CR input is kept in a whole-note card rather than normalized. Uniform LF and CRLF are restored after edits. This package supports a deliberate Markdown subset and does not claim full Obsidian compatibility. Wikilink nodes retain the raw token while the host provides title resolution and navigation in its own preview.

In controlled use, an echo of the editor's own latest value does not reset the ProseMirror document or selection. Opaque preservation nodes retain their exact Markdown through parse, edit, paste, and serialization. `onSerializationSafetyChange(false)` is reserved for an unexpected serializer failure; hosts should disable persistence and show the failure until it clears. Unsupported Markdown does not trigger a source-mode switch or pause saving.

The `minHeight` prop accepts pixels as a number or any valid CSS length string. The stylesheet uses `.mle-*` classes and `--mle-*` custom properties so a host can override presentation without inheriting application branding.

## Local development

This component is designed to be embedded in a host React app. The host owns the API and must supply adapters for any persistence or network access. The Markdown body remains the only editor storage contract; the package does not parse or rewrite application databases. The `examples/ControlledEditor.tsx` file shows the minimal controlled setup.

For package checks, install the pinned dependencies and run `npm test` and `npm run typecheck`. This repository does not publish the package to npm; consumers can install it from a Git dependency or vendor it into their app.

## Attribution and notices

The included editor is generic and contains no host application branding or assets. Third-party license notes are in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
