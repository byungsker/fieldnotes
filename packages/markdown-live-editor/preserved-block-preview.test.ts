import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreservedBlockPreview } from "./PreservedBlockPreview.tsx";
import type { PreservedBlockRenderer } from "./types.ts";

void React;

test("호스트 확장 없이 보존된 스크립트와 HTML을 실행하거나 표시하지 않는다", () => {
  const raw = "```dataviewjs\nthrow new Error('private source');\n```\n\n<script>privateSource()</script>";
  const html = renderToStaticMarkup(React.createElement(PreservedBlockPreview, { raw }));
  assert.match(html, /DataviewJS is preserved and was not run/u);
  assert.match(html, /Embedded HTML is preserved but not rendered/u);
  assert.doesNotMatch(html, /private source|privateSource|<script/u);
});

test("호스트 렌더러는 정확한 원문과 현재 문서 문맥을 받는다", () => {
  const raw = "~~~custom\r\nexact source\r\n~~~\r\n";
  const context = { documentId: "note-a", documentPath: "notes/a.md" };
  const renderer: PreservedBlockRenderer = (source, current) => {
    assert.equal(source, raw);
    assert.equal(current, context);
    return React.createElement("p", {}, `Host preview: ${current.documentId}`);
  };
  const html = renderToStaticMarkup(React.createElement(PreservedBlockPreview, { raw, context, renderPreservedBlock: renderer }));
  assert.match(html, /Host preview: note-a/u);
  assert.doesNotMatch(html, /exact source/u);
});

test("호스트가 지원하지 않는 블록은 안전한 기본 미리보기를 사용한다", () => {
  for (const result of [null, undefined]) {
    const html = renderToStaticMarkup(React.createElement(PreservedBlockPreview, {
      raw: "# Preserved title\n\n<script>privateSource()</script>",
      renderPreservedBlock: () => result,
    }));
    assert.match(html, /<h1>Preserved title<\/h1>/u);
    assert.doesNotMatch(html, /<script|privateSource/u);
  }
});
