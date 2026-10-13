import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedVisualizationFrameHeight,
  INITIAL_VISUALIZATION_FRAME_HEIGHT,
  MAX_VISUALIZATION_FRAME_HEIGHT,
} from "./visualization-frame-height.ts";

test("visualization frame height accepts finite values and clamps to safe bounds", () => {
  assert.equal(INITIAL_VISUALIZATION_FRAME_HEIGHT, 320);
  assert.equal(boundedVisualizationFrameHeight(220.1), 221);
  assert.equal(boundedVisualizationFrameHeight(20), 160);
  assert.equal(boundedVisualizationFrameHeight(MAX_VISUALIZATION_FRAME_HEIGHT + 500), MAX_VISUALIZATION_FRAME_HEIGHT);
  assert.equal(boundedVisualizationFrameHeight(Number.NaN), null);
  assert.equal(boundedVisualizationFrameHeight("500"), null);
});
