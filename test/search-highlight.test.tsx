import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { SearchHighlight } from "../src/SearchHighlight";

test("literal search highlighting safely marks Korean, English, and punctuation", () => {
  const markup = renderToStaticMarkup(React.createElement(SearchHighlight, {
    text: '이 글에는 테스트와 English, <script>alert("x")</script> 문자가 있어요.',
    query: '<script>alert("x")</script>',
  }));
  assert.match(markup, /<mark class="search-match">&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;<\/mark>/);
  assert.doesNotMatch(markup, /<script>/);
});

test("search highlighting accepts Korean and case-insensitive English matches", () => {
  const korean = renderToStaticMarkup(React.createElement(SearchHighlight, { text: "검색 테스트 내용", query: "테스트" }));
  const english = renderToStaticMarkup(React.createElement(SearchHighlight, { text: "An English NOTE", query: "note" }));
  assert.match(korean, /<mark class="search-match">테스트<\/mark>/);
  assert.match(english, /<mark class="search-match">NOTE<\/mark>/);
});
