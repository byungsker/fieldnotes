type ChangeListener = () => void;

type ChangeEventSource = Pick<EventSource, "addEventListener" | "close">;
type ChangeEventSourceFactory = (url: string) => ChangeEventSource;

function createVaultChangeSubscription(createEventSource: ChangeEventSourceFactory) {
  const listeners = new Set<ChangeListener>();
  let changeStream: ChangeEventSource | null = null;
  let readyReceived = false;

  function notifyListeners(): void {
    for (const listener of listeners) listener();
  }

  function subscribeToVaultChanges(listener: ChangeListener): () => void {
    listeners.add(listener);
    if (!changeStream) {
      readyReceived = false;
      changeStream = createEventSource("/api/events");
      changeStream.addEventListener("open", () => { readyReceived = false; });
      changeStream.addEventListener("change", () => { if (readyReceived) notifyListeners(); });
      changeStream.addEventListener("ready", () => {
        readyReceived = true;
        notifyListeners();
      });
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && changeStream) {
        changeStream.close();
        changeStream = null;
        readyReceived = false;
      }
    };
  }

  return subscribeToVaultChanges;
}

const subscribeToVaultChanges = createVaultChangeSubscription((url) => new EventSource(url));

export { createVaultChangeSubscription, subscribeToVaultChanges };
