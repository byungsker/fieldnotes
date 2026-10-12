import assert from "node:assert/strict";
import test from "node:test";
import { acquireVisualizationSlot } from "./visualization-worker-slots.ts";

test("limits active custom visualization Workers to two", async () => {
  const first = await acquireVisualizationSlot(new AbortController().signal);
  const second = await acquireVisualizationSlot(new AbortController().signal);
  let thirdReady = false;
  const thirdPromise = acquireVisualizationSlot(new AbortController().signal).then((release) => {
    thirdReady = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(thirdReady, false);
  first();
  const third = await thirdPromise;
  assert.equal(thirdReady, true);
  second();
  third();
});

test("cancels queued work and bounds the waiting queue", async () => {
  const first = await acquireVisualizationSlot(new AbortController().signal);
  const second = await acquireVisualizationSlot(new AbortController().signal);
  const cancelledController = new AbortController();
  const cancelled = acquireVisualizationSlot(cancelledController.signal);
  cancelledController.abort();
  await assert.rejects(cancelled, { name: "AbortError" });

  const queued = Array.from({ length: 6 }, () => acquireVisualizationSlot(new AbortController().signal));
  await assert.rejects(acquireVisualizationSlot(new AbortController().signal), /Too many visualizations/);
  first();
  second();
  for (let index = 0; index < queued.length; index += 2) {
    const releases = await Promise.all(queued.slice(index, index + 2));
    for (const release of releases) release();
  }
});
