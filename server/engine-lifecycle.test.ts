import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Engine } from "./engine.ts";
import { Store } from "./store.ts";
import { testFixture } from "./test-fixtures.ts";
import type { Runtime } from "./runtime.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("repeated ticks reserve bounded independent work while a scoped blocker and pause hold the frontier", async () => {
  const dir = await testFixture("looproom-engine-stress-");
  const store = new Store(join(dir, "db"));
  const runtime = Object.assign(new EventEmitter(), { close() {} }) as Runtime;
  const engine = new Engine(store, runtime, dir);
  const held = new Map<string, () => void>();
  const starts = new Map<string, number>();
  let peak = 0;
  try {
    store.put("settings", { concurrency: 4 }, "settings");
    const project = store.put("project", {
      status: "running", planned: true, escalationMode: "human", goal: "Fixture",
    });
    const blocked = store.put("task", {
      projectId: project.id, status: "ready", dependencies: [], title: "Blocked",
    });
    const gate = engine.gate(project.id, "Need input", "Fixture blocker", "decision", blocked.id);
    store.patch(gate.id, { judgeStatus: "answered" });
    const dependent = store.put("task", {
      projectId: project.id, status: "ready", dependencies: [blocked.id], title: "Dependent",
    });
    const independent = Array.from({ length: 20 }, (_, i) => store.put("task", {
      projectId: project.id, status: "ready", dependencies: [], title: `Independent ${i}`,
    }));
    engine.implement = async (_project, task) => {
      starts.set(task.id, (starts.get(task.id) ?? 0) + 1);
      store.patch(task.id, { status: "running" });
      peak = Math.max(peak, engine.busy.size);
      await new Promise<void>((resolve) => held.set(task.id, resolve));
      held.delete(task.id);
      store.patch(task.id, { status: "completed" });
    };
    for (let i = 0; i < 30; i++) engine.tick();
    await settle();
    assert.equal(engine.busy.size, 4);
    assert.equal(starts.size, 4);
    assert.equal(peak, 4);
    store.patch(project.id, { status: "paused" });
    for (const release of held.values()) release();
    await settle();
    engine.tick();
    await settle();
    assert.equal(starts.size, 4);
    assert.equal(engine.busy.size, 0);
    store.patch(project.id, { status: "running" });
    while (starts.size < independent.length) {
      for (let i = 0; i < 10; i++) engine.tick();
      await settle();
      assert.ok(engine.busy.size <= 4);
      for (const release of held.values()) release();
      await settle();
    }
    assert.equal(peak, 4);
    assert.deepEqual(independent.map((task) => starts.get(task.id)), Array(20).fill(1));
    assert.equal(starts.has(blocked.id), false);
    assert.equal(starts.has(dependent.id), false);
  } finally {
    engine.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart preserves interrupted task and judge gate without redispatch", async () => {
  const dir = await testFixture("looproom-restart-stress-");
  const path = join(dir, "db");
  let store = new Store(path);
  try {
    store.put("settings", { concurrency: 4 }, "settings");
    const project = store.put("project", {
      status: "running", planned: true, escalationMode: "yolo", goal: "Fixture",
    });
    const task = store.put("task", {
      projectId: project.id, status: "running", dependencies: [], title: "Interrupted",
    });
    const run = store.put("run", {
      projectId: project.id, taskId: task.id, role: "implementation", status: "running",
    });
    const gate = store.put("gate", {
      projectId: project.id, taskId: task.id, status: "open", type: "decision",
      judgeStatus: "running", judgeRecoveryStatus: "running", title: "Recovery",
    });
    store.close();
    store = new Store(path);
    store.recover();
    assert.equal(store.get(run.id).status, "interrupted");
    assert.equal(store.get(task.id).status, "blocked");
    assert.equal(store.get(project.id).status, "paused");
    assert.equal(store.get(gate.id).judgeStatus, "pending");
    assert.equal(store.get(gate.id).judgeRecoveryStatus, "interrupted");
    assert.equal(store.all("gate", project.id).filter(g => g.type === "interrupted").length, 1);
    const runtime = Object.assign(new EventEmitter(), { close() {} }) as Runtime;
    const engine = new Engine(store, runtime, dir);
    let dispatches = 0;
    engine.implement = async () => { dispatches++; };
    for (let i = 0; i < 30; i++) engine.tick();
    await settle();
    assert.equal(dispatches, 0);
    engine.close();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("two approval submissions for one revision cause one merge request and one durable approval", async () => {
  const dir = await testFixture("looproom-approve-race-");
  const store = new Store(join(dir, "db"));
  const runtime = Object.assign(new EventEmitter(), { close() {} }) as Runtime;
  const engine = new Engine(store, runtime, dir);
  let releaseInfo!: () => void;
  let signalInfo!: () => void;
  const infoStarted = new Promise<void>((resolve) => { signalInfo = resolve; });
  const infoHeld = new Promise<void>((resolve) => { releaseInfo = resolve; });
  const sha = "a".repeat(40);
  let mergeCalls = 0;
  try {
    const project = store.put("project", { status: "running", github: "example/fixture", branch: "main" });
    const task = store.put("task", { projectId: project.id, status: "awaiting_human" });
    const gate = store.put("gate", {
      projectId: project.id, taskId: task.id, status: "open", type: "pr",
      pr: "https://github.com/example/fixture/pull/1", sha,
    });
    engine.prInfo = async () => {
      signalInfo();
      await infoHeld;
      return { number: 1, url: gate.pr, baseRefName: "main", state: "OPEN", headRefOid: sha,
        statusCheckRollup: [], mergeable: "MERGEABLE" };
    };
    engine.mergeBroker = async () => { mergeCalls++; return JSON.stringify({ merged: true, sha: "b".repeat(40) }); };
    const first = engine.approve(gate.id, sha);
    await infoStarted;
    await assert.rejects(engine.approve(gate.id, sha), /already being submitted/);
    assert.equal(mergeCalls, 0);
    releaseInfo();
    await first;
    assert.equal(mergeCalls, 1);
    assert.equal(store.all("approval", project.id).length, 1);
    assert.equal(store.get(gate.id).status, "approved");
    assert.equal(store.get(task.id).status, "completed");
    await assert.rejects(engine.approve(gate.id, sha), /no longer open/);
    const malformed = store.put("gate", {
      projectId: project.id, taskId: project.id, status: "open", type: "pr", sha,
    });
    await assert.rejects(engine.approve(malformed.id, sha), /identity changed|Record not found/);
    assert.equal(mergeCalls, 1);
  } finally {
    engine.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("publication retry reuses only an open PR with the same head and base", async () => {
  const dir = await testFixture("looproom-pr-reconcile-");
  const store = new Store(join(dir, "db"));
  const runtime = Object.assign(new EventEmitter(), { close() {} }) as Runtime;
  const engine = new Engine(store, runtime, dir);
  const sha = "c".repeat(40);
  const project = { id: "project", github: "example/fixture", branch: "main" };
  const task = { id: "task", branch: "looproom/task", title: "Task" };
  const calls: string[][] = [];
  try {
    engine.githubRunner = async (args) => {
      calls.push(args);
      if (args[1] === "create") throw new Error("PR already exists");
      return JSON.stringify({
        url: "https://github.com/example/fixture/pull/1", state: "OPEN",
        headRefOid: sha, baseRefName: "main",
      });
    };
    assert.equal(await engine.createPrOrReuse(project, task, sha, "fixture-body.md"),
      "https://github.com/example/fixture/pull/1");
    assert.deepEqual(calls.map((args) => args[1]), ["create", "view"]);
    engine.githubRunner = async (args) => {
      if (args[1] === "create") throw new Error("PR already exists");
      return JSON.stringify({ url: "https://github.com/example/fixture/pull/1",
        state: "OPEN", headRefOid: "d".repeat(40), baseRefName: "main" });
    };
    await assert.rejects(engine.createPrOrReuse(project, task, sha, "fixture-body.md"),
      /does not match this task revision/);
  } finally {
    engine.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("request changes binds the current PR revision, preserves human feedback and cannot race a merge", async () => {
  const dir = await testFixture("looproom-request-changes-");
  const store = new Store(join(dir, "db"));
  const runtime = Object.assign(new EventEmitter(), { close() {} }) as Runtime;
  const engine = new Engine(store, runtime, dir);
  const sha = "a".repeat(40);
  const otherSha = "b".repeat(40);
  let head = sha;
  let releaseInfo!: () => void;
  let signalInfo!: () => void;
  let holdInfo = false;
  const infoStarted = new Promise<void>((resolve) => { signalInfo = resolve; });
  const infoHeld = new Promise<void>((resolve) => { releaseInfo = resolve; });
  let merges = 0;
  try {
    const project = store.put("project", { status: "paused", github: "example/fixture", branch: "main" });
    const task = store.put("task", {
      projectId: project.id, status: "awaiting_human", attempt: 2, judgeRetries: 2,
    });
    const gate = store.put("gate", {
      projectId: project.id, taskId: task.id, status: "open", type: "pr", sha, pr: "https://github.com/example/fixture/pull/1",
    });
    engine.prInfo = async () => {
      if (holdInfo) { signalInfo(); await infoHeld; }
      return { number: 1, url: gate.pr, baseRefName: "main", state: "OPEN", headRefOid: head,
        statusCheckRollup: [], mergeable: "MERGEABLE" };
    };
    engine.mergeBroker = async () => { merges++; return JSON.stringify({ merged: true, sha: otherSha }); };
    await assert.rejects(engine.requestChanges(gate.id, otherSha, "Fix this"),
      /displayed revision/);
    assert.equal(store.get(gate.id).status, "open");
    head = otherSha;
    await assert.rejects(engine.requestChanges(gate.id, sha, "Fix this"),
      /PR revision changed/);
    assert.equal(store.get(task.id).status, "awaiting_human");
    head = sha;
    holdInfo = true;
    const changes = engine.requestChanges(gate.id, sha, "Add a regression test");
    await infoStarted;
    await assert.rejects(engine.approve(gate.id, sha), /already being submitted/);
    releaseInfo();
    await changes;
    assert.equal(merges, 0);
    assert.equal(store.get(gate.id).status, "resolved");
    assert.equal(store.get(gate.id).reviewedSha, sha);
    assert.equal(store.get(task.id).status, "ready");
    assert.match(store.get(task.id).feedback, /Add a regression test/);
    assert.equal(store.get(task.id).attempt, 0);
    assert.equal(store.get(project.id).status, "paused");
    assert.equal(store.all("approval", project.id).length, 0);
    await assert.rejects(engine.requestChanges(gate.id, sha, "Again"), /no longer open/);
    await assert.rejects(engine.requestChanges(task.id, sha, "Wrong kind"), /Record not found/);
  } finally {
    engine.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
