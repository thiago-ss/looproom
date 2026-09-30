import test from "node:test";
import assert from "node:assert/strict";
import { frontierState, frontierGroup } from "../src/lib/work.ts";
test("work frontier distinguishes queued tasks from runnable work", () => {
  const parent = { id: "parent", status: "blocked", dependencies: [] };
  const child = { id: "child", status: "ready", dependencies: ["parent"] };
  assert.equal(frontierState(child, [parent, child]), "waiting");
  assert.equal(
    frontierState(child, [{ ...parent, status: "completed" }, child]),
    "ready",
  );
  assert.equal(frontierState(child, [child]), "waiting");
  assert.equal(
    frontierState({ ...child, status: "blocked" }, [parent, child]),
    "blocked",
  );
  assert.equal(frontierGroup("awaiting_human"), "attention");
  assert.equal(frontierGroup("verifying"), "active");
  assert.equal(frontierGroup("cancelled"), "finished");
});
