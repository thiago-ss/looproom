import test from "node:test";
import assert from "node:assert/strict";
import { escalationMode, needsHumanReview, taskOpenGate } from "../src/lib/autonomy.ts";

test("legacy bypass remains explicit and ordinary YOLO gates stay with the judge", () => {
  assert.equal(escalationMode({}), "human");
  assert.equal(escalationMode({ bypass: true }), "bypass");
  assert.equal(
    escalationMode({ bypass: true, escalationMode: "human" }),
    "human",
  );
  for (const type of [
    "decision",
    "verification",
    "runtime",
    "github",
    "planning",
    "dependency",
  ])
    assert.equal(
      needsHumanReview({ status: "open", type }, { escalationMode: "yolo" }),
      false,
    );
  assert.equal(
    needsHumanReview(
      { status: "open", type: "pr" },
      { escalationMode: "yolo" },
    ),
    true,
  );
  assert.equal(
    needsHumanReview(
      { status: "resolved", type: "pr" },
      { escalationMode: "yolo" },
    ),
    false,
  );
  assert.equal(
    needsHumanReview(
      { status: "open", type: "decision" },
      { escalationMode: "human" },
    ),
    true,
  );
});

test("open interruptions require human review in every mode", () => {
  for (const mode of ["human", "bypass", "yolo"]) {
    assert.equal(
      needsHumanReview({ status: "open", type: "interrupted" }, { escalationMode: mode }),
      true,
    );
    assert.equal(
      needsHumanReview({ status: "resolved", type: "interrupted" }, { escalationMode: mode }),
      false,
    );
  }
  assert.equal(
    needsHumanReview({ status: "open", type: "decision" }, { escalationMode: "yolo" }),
    false,
  );
});

test("Work selects a persisted interruption before the older open decision", () => {
  const gates = [
    { id: "decision", taskId: "task", type: "decision", status: "open" },
    { id: "interruption", taskId: "task", type: "interrupted", status: "open" },
  ];
  assert.equal(taskOpenGate(gates, "task")?.id, "interruption");
  assert.equal(taskOpenGate(gates, "other"), undefined);
  gates[1].status = "resolved";
  assert.equal(taskOpenGate(gates, "task")?.id, "decision");
});
