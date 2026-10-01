import test from "node:test";
import assert from "node:assert/strict";
import { escalationMode, needsHumanReview } from "../src/lib/autonomy.ts";

test("legacy bypass remains explicit and YOLO only requests human review for PRs", () => {
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
