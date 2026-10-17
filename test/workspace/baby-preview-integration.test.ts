import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreservedBlockPreview, PreservedMarkdownPreview } from "../../packages/markdown-live-editor/index.ts";
import { createBabiesPreservedBlockRenderer } from "../../src/pages/workspace/ui/BabiesPreservedBlock.tsx";
import { createBabiesPreviewAdapters } from "../../src/pages/workspace/api/baby-preview-adapters.ts";
import { createFieldnotesEditorAdapters } from "../../src/pages/workspace/api/editor-adapters.ts";

const renderer = createBabiesPreservedBlockRenderer({});
const supportedSource = "dv.pages('babies/records'); age_days; throw new Error('실행 금지');";
const supportedRaw = "```dataviewjs\n" + supportedSource + "\n```";

test("호스트 렌더러는 지원하는 Babies 문맥과 펜스만 정적 미리보기로 연결한다", () => {
  for (const raw of [supportedRaw, "~~~dataviewjs\r\n" + supportedSource + "\r\n~~~\r\n"]) {
    const preview = renderer(raw, { documentPath: "babies/dashboard.md" });
    assert.ok(React.isValidElement(preview));
    assert.match(renderToStaticMarkup(preview), /babies-view/);
  }
  for (const [raw, documentPath] of [
    [supportedRaw, "reading/dashboard.md"],
    ["```dataviewjs\nthrow new Error('실행 금지');\n```", "babies/dashboard.md"],
    ["```javascript\n" + supportedSource + "\n```", "babies/dashboard.md"],
    ["```dataviewjs\n" + supportedSource + "\n~~~", "babies/dashboard.md"],
  ]) {
    assert.equal(renderer(raw, { documentPath }), null);
  }
});

test("지원하지 않는 호스트 블록은 기본 미리보기에서 스크립트를 실행하지 않는다", () => {
  const html = renderToStaticMarkup(React.createElement(PreservedBlockPreview, {
    raw: "```dataviewjs\nthrow new Error('실행 금지');\n```",
    context: { documentPath: "babies/dashboard.md" },
    renderPreservedBlock: renderer,
  }));
  assert.doesNotMatch(html, /babies-view|<script/);
  assert.match(html, /mle-/);
});

test("로컬 이미지의 원문과 정규화 경로는 문서 범위에 맞는 API로 전달된다", () => {
  const adapters = createFieldnotesEditorAdapters();
  for (const source of ["cover.png", "../photos/cover.png", "/photos/cover.png"]) {
    const html = renderToStaticMarkup(React.createElement(PreservedMarkdownPreview, {
      raw: `![[${source}]]`,
      context: { documentId: "baby-id", documentPath: "babies/records/day.md", adapters },
    }));
    assert.match(html, /<img/);
    assert.ok(html.includes(`/api/preview/babies/asset?documentId=baby-id&amp;source=${encodeURIComponent(source)}`));
  }
  const render = (source: string, documentHash?: string) => renderToStaticMarkup(React.createElement(PreservedMarkdownPreview, {
    raw: `![[${source}]]`,
    context: { documentId: "note-id", documentPath: "reading/note.md", documentHash, adapters },
  }));
  assert.match(render("../photos/cover.png", "hash-v1"), /\/api\/views\/assets\/note-id\?asset=photos%2Fcover.png&amp;v=hash-v1/);
  assert.doesNotMatch(render("cover.png"), /<img/);
  for (const source of ["../../outside/cover.png", ".fieldnotes/secret.png", "javascript:alert.png", "//outside.test/cover.png", "cover.svg"]) {
    assert.doesNotMatch(render(source, "hash-v1"), /<img/);
    const babyHtml = renderToStaticMarkup(React.createElement(PreservedMarkdownPreview, {
      raw: `![[${source}]]`,
      context: { documentId: "baby-id", documentPath: "babies/day.md", adapters },
    }));
    assert.doesNotMatch(babyHtml, /<img/);
  }
});

test("Babies 어댑터는 취소 신호와 생성 본문을 기존 API에 전달한다", async (t) => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const document = { id: "fake-note", title: "합성 기록", body: "# 합성 기록", filePath: "babies/records/day.md" };
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return Response.json(url === "/api/preview/babies" ? { documents: [document] } : { document });
  });
  const adapters = createBabiesPreviewAdapters();
  const signal = new AbortController().signal;
  assert.deepEqual(await adapters.loadBabyPreviewDocuments!(signal), [document]);
  assert.equal(requests[0]?.url, "/api/preview/babies");
  assert.equal(requests[0]?.init?.signal, signal);
  const input = { title: document.title, body: document.body, folderId: "fake-records-folder" };
  assert.deepEqual(await adapters.createPreviewDocument!(input), document);
  assert.equal(requests[1]?.url, "/api/documents");
  assert.equal(requests[1]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), input);
  const asset = new URL(adapters.resolveVaultAsset!("fake-note", "photos/합성 기록.png"), "http://localhost");
  assert.equal(asset.pathname, "/api/preview/babies/asset");
  assert.equal(asset.searchParams.get("documentId"), "fake-note");
  assert.equal(asset.searchParams.get("source"), "photos/합성 기록.png");
});
