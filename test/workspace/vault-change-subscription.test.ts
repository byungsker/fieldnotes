import assert from "node:assert/strict";
import test from "node:test";
import { createVaultChangeSubscription } from "../../src/pages/workspace/api/vault-change-subscription.ts";

class FakeEventSource extends EventTarget {
  closed = false;

  close(): void {
    this.closed = true;
  }

  emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

test("vault change subscriptions ignore replay until ready and refresh once after catch-up", () => {
  const source = new FakeEventSource();
  const urls: string[] = [];
  const subscribe = createVaultChangeSubscription((url) => {
    urls.push(url);
    return source;
  });
  let firstCalls = 0;
  let secondCalls = 0;
  const unsubscribeFirst = subscribe(() => { firstCalls += 1; });
  const unsubscribeSecond = subscribe(() => { secondCalls += 1; });

  assert.deepEqual(urls, ["/api/events"]);
  source.emit("change");
  source.emit("change");
  assert.equal(firstCalls, 0);
  assert.equal(secondCalls, 0);

  source.emit("ready");
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);

  source.emit("change");
  assert.equal(firstCalls, 2);
  assert.equal(secondCalls, 2);

  unsubscribeFirst();
  source.emit("change");
  assert.equal(firstCalls, 2);
  assert.equal(secondCalls, 3);
  unsubscribeSecond();
  assert.equal(source.closed, true);
});

test("reconnected event streams discard replay rows and refresh once at the new ready watermark", () => {
  const source = new FakeEventSource();
  const subscribe = createVaultChangeSubscription(() => source);
  let calls = 0;
  const unsubscribe = subscribe(() => { calls += 1; });

  source.emit("open");
  source.emit("change");
  source.emit("change");
  assert.equal(calls, 0);
  source.emit("ready");
  assert.equal(calls, 1);
  source.emit("change");
  assert.equal(calls, 2);

  source.emit("open");
  source.emit("change");
  source.emit("change");
  assert.equal(calls, 2);
  source.emit("ready");
  assert.equal(calls, 3);
  source.emit("change");
  assert.equal(calls, 4);

  unsubscribe();
});
