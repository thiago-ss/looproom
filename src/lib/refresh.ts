// Serialize state reads so a response started before a later notification
// cannot replace the state fetched for that notification.
export function createRefresh<T>(
  fetchState: () => Promise<T>,
  onState: (state: T) => void,
  onError: (error: Error) => void,
) {
  let requested = 0;
  let pending: Promise<void> | null = null;
  let disposed = false;

  async function drain() {
    while (!disposed) {
      const current = requested;
      try {
        const state = await fetchState();
        if (disposed) return;
        if (current === requested) onState(state);
      } catch (error) {
        if (disposed) return;
        if (current === requested)
          onError(error instanceof Error ? error : new Error(String(error)));
      }
      if (current === requested) {
        pending = null;
        return;
      }
    }
    pending = null;
  }

  return {
    request(): Promise<void> {
      if (disposed) return Promise.resolve();
      requested++;
      if (!pending) pending = drain();
      return pending;
    },
    dispose() { disposed = true; },
  };
}
