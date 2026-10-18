import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreservedBlockPreview, PreservedMarkdownPreview } from "../../packages/markdown-live-editor/index.ts";
import { createFieldnotesEditorAdapters } from "../../src/pages/workspace/api/editor-adapters.ts";

const categories = ["babies", "reading", "movies", "a-category-added-later"];

test("Dataview JS는 폴더나 코드 패턴에 관계없이 실행하지 않는 보존 블록이다", () => {
  for (const category of categories) {
    const raw = "```dataviewjs\ndv.pages('" + category + "/records'); age_days; throw new Error('실행 금지');\n```";
    const html = renderToStaticMarkup(React.createElement(PreservedBlockPreview, {
      raw, context: { documentPath: `${category}/dashboard.md` },
    }));
    assert.doesNotMatch(html, /<script|babies-view|age_days|실행 금지/u);
    assert.match(html, /Dataview/u);
  }
});

test("모든 카테고리의 명시적 로컬 이미지는 같은 hash 검증 API를 사용한다", () => {
  const adapters = createFieldnotesEditorAdapters();
  for (const category of categories) {
    const render = (source: string, documentHash?: string) => renderToStaticMarkup(React.createElement(PreservedMarkdownPreview, {
      raw: `![[${source}]]`,
      context: { documentId: "note-id", documentPath: `${category}/records/day.md`, documentHash, adapters },
    }));
    for (const [source, assetPath] of [
      ["cover.png", `${category}/records/cover.png`],
      ["../photos/cover.png", `${category}/photos/cover.png`],
      ["/photos/cover.png", "photos/cover.png"],
    ] as const) {
      const html = render(source, "hash-v1");
      assert.match(html, /<img/u);
      assert.ok(html.includes(`/api/views/assets/note-id?asset=${encodeURIComponent(assetPath)}&amp;v=hash-v1`));
    }
    assert.doesNotMatch(render("cover.png"), /<img/u);
    for (const source of ["../../../outside/cover.png", ".fieldnotes/secret.png", "javascript:alert.png", "//outside.test/cover.png", "cover.svg"]) {
      assert.doesNotMatch(render(source, "hash-v1"), /<img/u);
    }
  }
});
