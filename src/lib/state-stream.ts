import { createRefreshQueue } from "./refresh-queue";

type StreamHandle = { close: () => void };
type OpenStream = (
  onMessage: () => void,
  onError: () => void,
  onOpen: () => void,
) => StreamHandle;

/** A state read establishes the session cookie before each event-stream attempt. */
export function createStateStream<T>(
  load: () => Promise<T>,
  onData: (data: T) => void,
  onError: (error: Error) => void,
  openStream: OpenStream,
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout,
  cancel: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
) {
  let stream: StreamHandle | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let canConnect = true;
  let failures = 0;
  let streamGeneration = 0;

  const queue = createRefreshQueue(
    load,
    (data) => {
      onData(data);
      if (!stopped && canConnect && !stream) connect();
    },
    (error) => {
      onError(error);
      if (!stream) retry();
    },
  );

  function retry() {
    if (stopped || retryTimer !== null) return;
    canConnect = false;
    const delay = Math.min(1000 * 2 ** Math.min(failures++, 4), 15000);
    retryTimer = schedule(() => {
      retryTimer = null;
      if (stopped) return;
      canConnect = true;
      void queue.refresh();
    }, delay);
  }

  function connect() {
    if (stopped || stream || !canConnect) return;
    const generation = ++streamGeneration;
    stream = openStream(
      () => {
        if (!stopped && generation === streamGeneration) void queue.refresh();
      },
      () => {
        if (stopped || generation !== streamGeneration) return;
        stream?.close();
        stream = null;
        ++streamGeneration;
        retry();
      },
      () => {
        if (!stopped && generation === streamGeneration) failures = 0;
      },
    );
  }

  function stop() {
    stopped = true;
    queue.stop();
    ++streamGeneration;
    if (retryTimer !== null) cancel(retryTimer);
    retryTimer = null;
    stream?.close();
    stream = null;
  }

  return { refresh: queue.refresh, stop };
}
