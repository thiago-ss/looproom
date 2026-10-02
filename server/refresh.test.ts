import assert from "node:assert/strict";
import test from "node:test";
import { createRefresh } from "../src/lib/refresh.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("overlapping notifications coalesce and stale responses never apply", async () => {
  const first = deferred<number>();
  const second = deferred<number>();
  const reads = [first, second];
  const applied: number[] = [];
  const refresh = createRefresh(() => reads.shift()!.promise, (state) => applied.push(state), () => {});
  const pending = refresh.request();
  const overlap = refresh.request();
  refresh.request();
  assert.equal(reads.length, 1);
  first.resolve(1);
  await Promise.resolve();
  assert.deepEqual(applied, []);
  assert.equal(reads.length, 0);
  second.resolve(2);
  await Promise.all([pending, overlap]);
  assert.deepEqual(applied, [2]);
});

test("failed reads recover on a later polling or reconnect trigger", async () => {
  let calls = 0;
  const states: number[] = [];
  const errors: string[] = [];
  const refresh = createRefresh(
    async () => { if (++calls === 1) throw new Error("offline"); return calls; },
    (state) => states.push(state),
    (error) => errors.push(error.message),
  );
  await refresh.request();
  await refresh.request();
  assert.deepEqual(errors, ["offline"]);
  assert.deepEqual(states, [2]);
});

test("disposed refresh ignores an in-flight response", async () => {
  const read = deferred<number>();
  const states: number[] = [];
  const refresh = createRefresh(() => read.promise, (state) => states.push(state), () => {});
  const pending = refresh.request();
  refresh.dispose();
  read.resolve(1);
  await pending;
  assert.deepEqual(states, []);
});
