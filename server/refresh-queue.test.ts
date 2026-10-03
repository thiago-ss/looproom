import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshQueue } from "../src/lib/refresh-queue.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("refresh bursts read once more and apply only the current snapshot", async () => {
  const first = deferred<number>();
  const second = deferred<number>();
  const loads: Array<ReturnType<typeof deferred<number>>> = [first, second];
  const applied: number[] = [];
  let active = 0;
  let maxActive = 0;
  const queue = createRefreshQueue(
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      const result = await loads.shift()!.promise;
      active--;
      return result;
    },
    (value) => applied.push(value),
    () => assert.fail("unexpected refresh error"),
  );

  const initial = queue.refresh();
  const burst = Array.from({ length: 100 }, () => queue.refresh());
  first.resolve(1);
  await Promise.resolve();
  second.resolve(2);
  await Promise.all([initial, ...burst]);

  assert.equal(maxActive, 1);
  assert.deepEqual(applied, [2]);
  assert.equal(loads.length, 0);
});

test("stopped refreshes ignore late responses and trailing work", async () => {
  const first = deferred<number>();
  const applied: number[] = [];
  let loads = 0;
  const queue = createRefreshQueue(
    () => { loads++; return first.promise; },
    (value) => applied.push(value),
    () => assert.fail("unexpected refresh error"),
  );
  const pending = queue.refresh();
  void queue.refresh();
  queue.stop();
  first.resolve(1);
  await pending;
  await queue.refresh();
  assert.equal(loads, 1);
  assert.deepEqual(applied, []);
});

test("refresh recovers after a failed read", async () => {
  let attempts = 0;
  const errors: string[] = [];
  const applied: number[] = [];
  const queue = createRefreshQueue(
    async () => {
      if (++attempts === 1) throw new Error("offline");
      return 2;
    },
    (value) => applied.push(value),
    (error) => errors.push(error.message),
  );
  await queue.refresh();
  await queue.refresh();
  assert.deepEqual(errors, ["offline"]);
  assert.deepEqual(applied, [2]);
});
