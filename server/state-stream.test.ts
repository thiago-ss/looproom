import test from "node:test";
import assert from "node:assert/strict";
import { createStateStream } from "../src/lib/state-stream.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const reads: Array<ReturnType<typeof deferred<number>>> = [];
  const streams: Array<{ closeCount: number; message: () => void; error: () => void; open: () => void }> = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const applied: number[] = [];
  const errors: string[] = [];
  let nextTimer = 0;
  const lifecycle = createStateStream(
    () => {
      const read = deferred<number>();
      reads.push(read);
      return read.promise;
    },
    (value) => applied.push(value),
    (error) => errors.push(error.message),
    (message, error, open) => {
      const stream = { closeCount: 0, message, error, open };
      streams.push(stream);
      return { close: () => { stream.closeCount++; } };
    },
    (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    (id) => { timers.delete(id as unknown as number); },
  );
  function fireTimer() {
    const [id, timer] = timers.entries().next().value!;
    timers.delete(id);
    timer.callback();
    return timer.delay;
  }
  return { lifecycle, reads, streams, timers, applied, errors, fireTimer };
}

test("state is fetched before opening exactly one event stream", async () => {
  const h = harness();
  const pending = h.lifecycle.refresh();
  assert.equal(h.reads.length, 1);
  assert.equal(h.streams.length, 0);
  h.reads[0].resolve(1);
  await pending;
  assert.deepEqual(h.applied, [1]);
  assert.equal(h.streams.length, 1);
  h.lifecycle.stop();
  assert.equal(h.streams[0].closeCount, 1);
});

test("terminal stream error refreshes session before reconnecting with bounded retry", async () => {
  const h = harness();
  const initial = h.lifecycle.refresh();
  h.reads[0].resolve(1);
  await initial;
  h.streams[0].error(); // A stale cookie after coordinator restart closes EventSource.
  assert.equal(h.streams[0].closeCount, 1);
  assert.equal(h.streams.length, 1);
  assert.equal(h.fireTimer(), 1000);
  assert.equal(h.reads.length, 2);
  assert.equal(h.streams.length, 1);
  h.reads[1].reject(new Error("coordinator restarting"));
  await new Promise(setImmediate);
  assert.deepEqual(h.errors, ["coordinator restarting"]);
  assert.equal(h.fireTimer(), 2000);
  assert.equal(h.reads.length, 3);
  h.reads[2].resolve(2);
  await new Promise(setImmediate);
  assert.deepEqual(h.applied, [1, 2]);
  assert.equal(h.streams.length, 2);
  h.streams[0].message();
  h.streams[0].error();
  assert.equal(h.reads.length, 3);
  assert.equal(h.streams[1].closeCount, 0);
  h.streams[1].open();
  h.lifecycle.stop();
});

test("cleanup prevents late reads, streams, and retry callbacks", async () => {
  const h = harness();
  const pending = h.lifecycle.refresh();
  h.lifecycle.stop();
  h.reads[0].resolve(1);
  await pending;
  assert.deepEqual(h.applied, []);
  assert.equal(h.streams.length, 0);
  assert.equal(h.timers.size, 0);

  const recovered = harness();
  const first = recovered.lifecycle.refresh();
  recovered.reads[0].resolve(1);
  await first;
  recovered.streams[0].error();
  assert.equal(recovered.timers.size, 1);
  recovered.lifecycle.stop();
  assert.equal(recovered.timers.size, 0);
  recovered.streams[0].message();
  assert.equal(recovered.reads.length, 1);
});

test("reconnect delay caps at fifteen seconds", async () => {
  const h = harness();
  const first = h.lifecycle.refresh();
  h.reads[0].reject(new Error("offline"));
  await first;
  const delays: number[] = [];
  for (let index = 1; index <= 6; index++) {
    delays.push(h.fireTimer());
    h.reads[index].reject(new Error("offline"));
    await new Promise(setImmediate);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000, 15000]);
  assert.equal(h.streams.length, 0);
  h.lifecycle.stop();
});
