import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "./store.ts";
import { testFixture } from "./test-fixtures.ts";

test("SQLite survives restart, searches only the selected project, and rolls back failed writes", async () => {
  const dir = await testFixture("looproom-store-");
  const path = join(dir, "state.sqlite");
  let store = new Store(path);
  try {
    store.memory(
      "one",
      "Worktree isolation",
      "A sandbox blocks writes outside the task.",
      ["source.ts"],
    );
    store.memory("two", "Worktree isolation", "Private second project.", []);
    assert.equal(store.search("one", 'worktree " OR **').length, 1);
    assert.throws(() =>
      store.transaction(() => {
        store.put("task", { projectId: "one" }, "rolled-back");
        throw new Error("fail");
      }),
    );
    assert.throws(() => store.get("rolled-back"));
    store.close();
    store = new Store(path);
    assert.equal(store.search("one", "sandbox")[0].sources[0], "source.ts");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a crash preserves work and creates one actionable recovery gate", async () => {
  const dir = await testFixture("looproom-recovery-");
  const store = new Store(join(dir, "db"));
  try {
    store.put("project", { status: "running" }, "p");
    store.put(
      "task",
      { projectId: "p", status: "running", worktree: "/preserved/worktree" },
      "t",
    );
    store.put(
      "run",
      { projectId: "p", taskId: "t", status: "running", threadId: "thread" },
      "r",
    );
    store.recover();
    store.recover();
    assert.equal(store.get("p").status, "paused");
    assert.equal(store.get("r").status, "interrupted");
    assert.equal(store.get("t").worktree, "/preserved/worktree");
    assert.equal(store.all("gate", "p").length, 1);
    assert.equal(store.all("approval").length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery also catches a crash between the agent turn and broker verification", async () => {
  const dir = await testFixture("looproom-check-recovery-");
  const store = new Store(join(dir, "db"));
  try {
    store.put("project", { status: "running" }, "p");
    store.put("task", { projectId: "p", status: "verifying", checks: [] }, "t");
    store.recover();
    assert.equal(store.get("t").status, "blocked");
    assert.equal(store.get("p").status, "paused");
    assert.equal(store.all("gate").length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery adds one interruption gate even when the task has another open decision", async () => {
  const dir = await testFixture("looproom-decision-recovery-");
  const store = new Store(join(dir, "db"));
  try {
    store.put("project", { status: "running" }, "p");
    store.put("task", { projectId: "p", status: "verifying", worktree: "/preserved/worktree" }, "t");
    store.put("gate", { projectId: "p", taskId: "t", type: "decision", status: "open" }, "decision");
    store.recover();
    store.recover();
    assert.equal(store.get("p").status, "paused");
    assert.equal(store.get("t").worktree, "/preserved/worktree");
    assert.equal(store.all("gate", "p").filter((gate) => gate.type === "interrupted").length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart gates a running YOLO recovery and judge exactly once", async () => {
  const dir = await testFixture("looproom-judge-check-recovery-");
  let store = new Store(join(dir, "db"));
  try {
    store.put("project", { status: "running", escalationMode: "yolo" }, "p");
    store.put("task", { projectId: "p", status: "blocked", worktree: "/preserved/worktree" }, "t");
    store.put("gate", {
      projectId: "p", taskId: "t", type: "decision", status: "open",
      judgeStatus: "running", judgeRecoveryStatus: "running",
    }, "decision");
    store.put("run", { projectId: "p", taskId: "t", role: "judge", status: "running" }, "judge-run");
    store.close();
    store = new Store(join(dir, "db"));
    store.recover();
    store.recover();
    assert.equal(store.get("decision").judgeRecoveryStatus, "interrupted");
    assert.equal(store.get("judge-run").status, "interrupted");
    assert.equal(store.get("p").status, "paused");
    assert.equal(store.get("t").worktree, "/preserved/worktree");
    assert.equal(store.all("gate", "p").filter((gate) => gate.type === "interrupted").length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("read-only judge assessments do not create interruption gates", async () => {
  const dir = await testFixture("looproom-read-only-judge-restart-");
  const store = new Store(join(dir, "db"));
  try {
    for (const [mode, gateType] of [
      ["human", "decision"], ["bypass", "decision"], ["yolo", "pr"],
    ]) {
      const projectId = mode + ":" + gateType;
      const taskId = projectId + ":task";
      store.put("project", { status: "running", escalationMode: mode }, projectId);
      store.put("task", { projectId, status: "blocked", worktree: "/preserved/worktree" }, taskId);
      store.put("gate", {
        projectId, taskId, type: gateType, status: "open", judgeStatus: "running",
      });
      store.put("run", { projectId, taskId, role: "judge", status: "running" });
    }
    store.recover();
    for (const project of store.all("project")) {
      assert.equal(project.status, "running");
      assert.equal(store.all("gate", project.id).filter((gate) => gate.type === "interrupted").length, 0);
      assert.equal(store.all("run", project.id)[0].status, "interrupted");
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
