/** Keep state snapshots in request order while folding bursts into one trailing read. */
export function createRefreshQueue<T>(
  load: () => Promise<T>,
  onData: (data: T) => void,
  onError: (error: Error) => void,
) {
  let inFlight: Promise<void> | null = null;
  let pending = false;
  let stopped = false;

  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight) {
      pending = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        pending = false;
        try {
          const data = await load();
          if (!stopped && !pending) onData(data);
        } catch (error) {
          if (!stopped && !pending) onError(error as Error);
        }
      } while (pending && !stopped);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function stop() {
    stopped = true;
    pending = false;
  }

  return { refresh, stop };
}
