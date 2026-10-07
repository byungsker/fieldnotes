import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDocumentDate } from "../src/document-date.js";

test("document timestamps remain relative until the exact 24-hour boundary", () => {
  const now = Date.parse("2026-10-06T15:00:00.000Z");
  assert.equal(formatDocumentDate("2026-10-05T15:01:00.000Z", now), "23h ago");
  assert.equal(formatDocumentDate("2026-10-05T15:00:00.000Z", now), "2026년 10월 6일");
});

test("document dates are rendered in Korean calendar time across UTC midnight", () => {
  const value = "2026-10-06T14:59:59.000Z";
  assert.equal(formatDocumentDate(value, Date.parse("2026-10-07T15:00:00.000Z")), "2026년 10월 6일");
  assert.equal(formatDocumentDate("invalid-date"), "Unknown");
});
