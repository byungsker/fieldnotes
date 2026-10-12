type ChangeListener = () => void;

const listeners = new Set<ChangeListener>();
let changeStream: EventSource | null = null;
let readyReceived = false;

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function subscribeToVaultChanges(listener: ChangeListener): () => void {
  listeners.add(listener);
  if (!changeStream) {
    readyReceived = false;
    changeStream = new EventSource("/api/events");
    changeStream.addEventListener("change", notifyListeners);
    changeStream.addEventListener("ready", () => {
      if (readyReceived) notifyListeners();
      readyReceived = true;
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

export { subscribeToVaultChanges };
