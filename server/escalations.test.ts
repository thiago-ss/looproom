import test from "node:test";
import assert from "node:assert/strict";
import { createChimeGate, groupEscalationNotices, recordGateSnapshot } from "../src/lib/escalations.ts";
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

test("38 fresh gates produce one project notice while retaining every decision", () => {
  const gates = Array.from({ length: 38 }, (_, index) => ({
    id: `gate-${index}`,
    projectId: "alpha",
    status: "open",
    type: "capability",
    title: `Decision ${index}`,
  }));
  const seen = new Set<string>();
  const fresh = recordGateSnapshot(gates, seen);
  const notices = groupEscalationNotices(gates, fresh, [
    { id: "alpha", name: "Alpha", escalationMode: "human" },
  ]);
  assert.equal(gates.length, 38);
  assert.equal(seen.size, 38);
  assert.deepEqual(notices, [{
    projectId: "alpha",
    projectName: "Alpha",
    count: 38,
    title: "38 decisions need you",
    type: "Review",
  }]);
  assert.deepEqual(groupEscalationNotices(gates, recordGateSnapshot(gates, seen), [
    { id: "alpha", name: "Alpha" },
  ]), []);
});

test("a new gate updates one notice per affected project with current counts", () => {
  const gates = [
    { id: "old-alpha", projectId: "alpha", status: "open", type: "capability", title: "Older" },
    { id: "new-alpha", projectId: "alpha", status: "open", type: "capability", title: "New" },
    { id: "new-beta", projectId: "beta", status: "open", type: "pr", title: "Review PR" },
  ];
  const notices = groupEscalationNotices(gates, gates.slice(1), [
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
  ]);
  assert.equal(notices.length, 2);
  assert.deepEqual(notices.map((notice) => [notice.projectId, notice.count, notice.title]), [
    ["alpha", 2, "2 decisions need you"],
    ["beta", 1, "Review PR"],
  ]);
});

test("YOLO notices include PR gates only", () => {
  const gates = [
    { id: "routine", projectId: "auto", status: "open", type: "capability", title: "Routine" },
    { id: "pr", projectId: "auto", status: "open", type: "pr", title: "Review PR" },
  ];
  const notices = groupEscalationNotices(gates, gates, [
    { id: "auto", name: "Auto", escalationMode: "yolo" },
  ]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].count, 1);
  assert.equal(notices[0].title, "Review PR");
  assert.equal(gates.length, 2);
});

test("automatic chimes are limited to one per three-second burst", () => {
  const canChime = createChimeGate(3000);
  assert.equal(canChime(0), true);
  assert.equal(canChime(200), false);
  assert.equal(canChime(2999), false);
  assert.equal(canChime(3000), true);
});
