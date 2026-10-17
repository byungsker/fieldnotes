# Markdown Live Editor

A reusable controlled Markdown editor for React 19. It accepts Markdown as a string and keeps persistence, view queries, live-change subscriptions, image handling, bookmark metadata, and snippets behind injected adapters.

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
  queryVisualization: (query, signal) => applicationApi.queryVisualization(query, signal),
  subscribeToVaultChanges: (onChange) => applicationApi.subscribeToVaultChanges(onChange),
  enableCustomVisualizations: false,
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
- A fenced `fieldnotes-view` block is represented as one atomic TipTap node with its complete raw Markdown fence stored in an attribute. The editor serializes that source exactly, offers an explicit source editor, and renders native tables/calendars from an injected query adapter. Custom JavaScript runs only after an explicit, revocable approval of that exact note, block, and source fingerprint.

The Markdown extension is the official `@tiptap/markdown` 3.31.4 package. It is still marked beta by its maintainers and does not promise support for every Markdown dialect. The editor checks each block before displaying it as rich content. Blocks the editor cannot round-trip exactly become read-only preservation cards, including a whole-note card if parsing cannot safely segment the document. Mixed LF/CRLF or bare-CR input is kept in a whole-note card rather than normalized. Uniform LF and CRLF are restored after edits. This package supports a deliberate Markdown subset and does not claim full Obsidian compatibility. Wikilink nodes retain the raw token while the host provides title resolution and navigation in its own preview.

`fieldnotes-view` is a Fieldnotes format and does not implement Dataview or `dv` APIs. The host query adapter returns bounded note metadata and safe-subset frontmatter. Custom JS expects a synchronous `fieldnotesRender(notes, escapeHtml, state, trash)` function body that returns `{ html, css }`. It runs in a disposable Worker with browser APIs masked and a CSP that limits dynamic script loading to Blob URLs; it has no DOM, app storage, file-write, or network API. The editor checks local approval for the exact source before it runs. Sanitized buttons and forms can emit only typed, size-limited actions over a dedicated `MessagePort`; the server independently validates action IDs, allowed fields, and expected versions/hashes before writing. The server does not use the browser's local trust record as authorization. The sandbox limits note input to 200 records / 1 MB, source to 16 KB, HTML to 48 KB, CSS to 12 KB, execution to 700 ms, and concurrent Workers to 2 (6 queued). Browsers do not provide a portable hard per-Worker memory quota. See the [security notes](../../docs/fieldnotes-visualizations-security.md).

In controlled use, an echo of the editor's own latest value does not reset the ProseMirror document or selection. Opaque preservation nodes retain their exact Markdown through parse, edit, paste, and serialization. `onSerializationSafetyChange(false)` is reserved for an unexpected serializer failure; hosts should disable persistence and show the failure until it clears. Unsupported Markdown does not trigger a source-mode switch or pause saving.

The `minHeight` prop accepts pixels as a number or any valid CSS length string. The stylesheet uses `.mle-*` classes and `--mle-*` custom properties so a host can override presentation without inheriting application branding.

## 호스트별 미리보기

호스트는 `renderPreservedBlock(raw, context)`로 보존 블록의 React UI를 제공할 수 있습니다. `null` 또는 `undefined`를 반환하면 기본 미리보기를 사용합니다. 확장은 신뢰할 수 있는 호스트 코드이며, Markdown에 포함된 JavaScript를 실행하는 경로가 아닙니다. 보존 노드의 원문과 직렬화는 렌더링 결과에 영향을 받지 않습니다.

`adapters.resolveLocalImage`는 검증을 통과한 이미지의 원문 `source`, 해석된 `assetPath`, 문서 ID·경로·hash를 받습니다. 호스트가 URL을 반환하거나 `null`로 미리보기를 거절할 수 있습니다. 이 어댑터가 없으면 기존 `resolveReferencedVaultAsset`를 사용하며, 둘 다 없으면 이미지를 불러오지 않습니다. Fieldnotes의 육아 기록 UI·API·스타일은 호스트 `src/pages/workspace/`에 있습니다.

시각화 타입과 이벤트 검증은 패키지 내부 `visualization-contract.ts`에 한 번 정의합니다. `markdown-live-editor/visualization-contract`로 React UI 없이 계약 모듈을 참조할 수 있고, 호스트의 `shared/visualization.ts`는 같은 정의를 재export합니다. 패키지 소스는 상위 저장소 모듈을 import하지 않습니다.

## 로컬 개발과 독립 검증

This component is designed to be embedded in a host React app. The host owns the API and must supply adapters for any persistence or network access. The Markdown body remains the only editor storage contract; the package does not parse or rewrite application databases. The `examples/ControlledEditor.tsx` file shows the minimal controlled setup.

패키지 디렉터리에서 `npm ci`, `npm run typecheck`, `npm test`를 실행합니다. 독립성을 검증하려면 이 디렉터리만 저장소 밖의 임시 경로에 복사하고 같은 명령을 실행합니다. 루트의 `shared/`나 node_modules를 복사할 필요가 없습니다. 이 저장소는 패키지를 npm에 게시하지 않으며, 소비 앱은 패키지 폴더를 가져와 사용합니다.

## Attribution and notices

The included editor is generic and contains no host application branding or assets. Third-party license notes are in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
