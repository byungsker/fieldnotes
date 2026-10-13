const MAX_ACTIVE_VISUALIZATIONS = 2;
const MAX_QUEUED_VISUALIZATIONS = 6;
type Waiter = { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: Error) => void; abort: () => void };

let active = 0;
const waiters: Waiter[] = [];

function releaseSlot(): void {
  active = Math.max(0, active - 1);
  while (active < MAX_ACTIVE_VISUALIZATIONS && waiters.length) {
    const waiter = waiters.shift();
    if (!waiter) break;
    waiter.signal.removeEventListener("abort", waiter.abort);
    if (waiter.signal.aborted) continue;
    active += 1;
    waiter.resolve(() => releaseSlot());
  }
}

function acquireVisualizationSlot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(new DOMException("Visualization run cancelled.", "AbortError"));
  if (active < MAX_ACTIVE_VISUALIZATIONS) {
    active += 1;
    return Promise.resolve(() => releaseSlot());
  }
  if (waiters.length >= MAX_QUEUED_VISUALIZATIONS) return Promise.reject(new Error("Too many visualizations are waiting to run."));
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      signal,
      resolve,
      reject,
      abort: () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new DOMException("Visualization run cancelled.", "AbortError"));
      },
    };
    waiters.push(waiter);
    signal.addEventListener("abort", waiter.abort, { once: true });
  });
}

export { acquireVisualizationSlot };
