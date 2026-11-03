import assert from "node:assert/strict";
import test from "node:test";
import { MarkdownUpdateScheduler } from "./markdown-update-scheduler.ts";

class FakeFrames {
  private nextId = 1;
  callbacks = new Map<number, FrameRequestCallback>();

  request = (callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };

  cancel = (id: number): void => {
    this.callbacks.delete(id);
  };

  flush(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(0);
  }
}

test("rapid editor updates serialize only the latest state once per frame", () => {
  const frames = new FakeFrames();
  const updates: string[] = [];
  const scheduler = new MarkdownUpdateScheduler((value: string) => updates.push(value), frames.request, frames.cancel);

  for (let index = 1; index <= 20; index += 1) scheduler.schedule(`body-${index}`);
  assert.equal(frames.callbacks.size, 1);
  assert.deepEqual(updates, []);

  frames.flush();
  assert.deepEqual(updates, ["body-20"]);
});

test("blur flushes pending serialization synchronously and cancels the frame", () => {
  const frames = new FakeFrames();
  const updates: string[] = [];
  const scheduler = new MarkdownUpdateScheduler((value: string) => updates.push(value), frames.request, frames.cancel);
  scheduler.schedule("latest body");

  scheduler.flush();
  frames.flush();
  assert.deepEqual(updates, ["latest body"]);
});

test("composition end can force one final serialization without a queued update", () => {
  const frames = new FakeFrames();
  const updates: string[] = [];
  const scheduler = new MarkdownUpdateScheduler((value: string) => updates.push(value), frames.request, frames.cancel);

  scheduler.flush("composed body", true);
  assert.deepEqual(updates, ["composed body"]);
});
