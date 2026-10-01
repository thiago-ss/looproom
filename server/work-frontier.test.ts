import test from "node:test";
import assert from "node:assert/strict";
import {
  frontierState,
  frontierGroup,
  waitingOnBlocker,
  submittedWait,
} from "../src/lib/work.ts";
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

test("submitted judge waits remain blockers; independent work and active runs stay runnable", () => {
  const project = { status: "running", planned: true };
  const parent = { id: "blocked", status: "blocked", dependencies: [] };
  const child = { id: "child", status: "ready", dependencies: [parent.id] };
  const gate = { status: "open", taskId: parent.id, scope: "task" };
  assert.equal(waitingOnBlocker(project, [parent, child], [gate], []), true);
  assert.equal(
    waitingOnBlocker(
      project,
      [parent, child],
      [gate],
      [{ status: "running", role: "judge" }],
    ),
    true,
  );
  assert.equal(
    waitingOnBlocker(
      project,
      [parent, child, { id: "free", status: "ready", dependencies: [] }],
      [gate],
      [],
    ),
    false,
  );
  assert.equal(
    waitingOnBlocker(
      project,
      [parent, child],
      [gate],
      [{ status: "running", role: "implementation" }],
    ),
    false,
  );
  assert.equal(
    waitingOnBlocker(
      { ...project, status: "paused" },
      [parent, child],
      [gate],
      [],
    ),
    false,
  );
  assert.equal(waitingOnBlocker(project, [parent, child], [], []), false);
  const message = {
    role: "judge",
    kind: "escalation_response",
    runId: "latest",
  };
  const waiting = {
    status: "open",
    awaitingCapability: true,
    judgeRunId: "latest",
  };
  assert.equal(submittedWait(message, waiting), true);
  assert.equal(submittedWait({ ...message, runId: "old" }, waiting), false);
  assert.equal(
    submittedWait({ ...message, kind: "escalation_draft" }, waiting),
    false,
  );
  assert.equal(
    submittedWait(message, { ...waiting, status: "resolved" }),
    false,
  );
});
