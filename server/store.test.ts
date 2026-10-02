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
    assert.equal(store.search("two", "sandbox").length, 0);
    assert.equal(store.search("two", "worktree")[0].projectId, "two");
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
