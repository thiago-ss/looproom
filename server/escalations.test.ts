import test from "node:test";
import assert from "node:assert/strict";
import { recordGateSnapshot } from "../src/lib/escalations.ts";
test("escalations alert once for new open gates, never replay history or routine activity", () => {
  const seen = new Set<string>();
  const historical = [
    { id: "old", status: "open" },
    { id: "resolved", status: "resolved" },
  ];
  assert.deepEqual(recordGateSnapshot(historical, seen, true), []);
  const fresh = { id: "new", status: "open" };
  assert.deepEqual(recordGateSnapshot([...historical, fresh, fresh], seen), [
    fresh,
  ]);
  assert.deepEqual(recordGateSnapshot([...historical, fresh], seen), []);
  const persisted = new Set(JSON.parse(JSON.stringify([...seen])) as string[]);
  assert.deepEqual(recordGateSnapshot([fresh], persisted), []);
  assert.deepEqual(
    recordGateSnapshot(
      [{ id: "closed-before-refresh", status: "resolved" }],
      persisted,
    ),
    [],
  );
});
