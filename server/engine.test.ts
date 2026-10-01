import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { Runtime } from "./runtime.ts";
import { createRepo } from "./git.ts";
import { testFixture } from "./test-fixtures.ts";

class FixtureRuntime extends EventEmitter {
  binary = "";
  home = "";
  profiles: string[] = [];
  async run(options: any) {
    this.profiles.push(options.model + "/" + options.effort);
    options.onThread("fixture-thread");
    if (options.prompt.includes("Independently inspect"))
      return JSON.stringify({
        verdict: "pass",
        summary: "Read the written source and confirmed the fixture result.",
        sources: ["result.txt"],
      });
    if (options.write) {
      await writeFile(join(options.cwd, "result.txt"), "useful work");
      return JSON.stringify({
        summary: "Added the result.",
        sources: ["result.txt"],
        humanQuestion: "",
      });
    }
    return JSON.stringify({
      summary: "Read the repository and identified one useful task.",
      gate: "",
      sources: ["README.md"],
      tasks: [
        {
          title: "Write result",
          description: "Create the fixture result.",
          acceptance: ["result.txt contains useful work"],
          dependencies: [],
          kind: "implementation",
        },
      ],
    });
  }
  close() {}
}

test("interruption waits for a human even after another decision is answered", async () => {
  const dir = await testFixture("looproom-human-restart-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, new FixtureRuntime() as unknown as Runtime, dir);
  try {
    const project = store.put("project", { status: "running" });
    const task = store.put("task", { projectId: project.id, status: "running", worktree: "/preserved/worktree" });
    const decision = store.put("gate", { projectId: project.id, taskId: task.id, status: "open", type: "decision" });
    store.recover();
    const interruption = store.all("gate", project.id).find((gate) => gate.type === "interrupted")!;
    await assert.rejects(engine.resolve(interruption.id, "retry", true, "judge"), /human resolution/);
    await engine.resolve(decision.id, "Continue after recovery", true);
    assert.equal(store.get(project.id).status, "paused");
    await engine.resolve(interruption.id, "I reviewed the preserved worktree; retry", true);
    assert.equal(store.get(project.id).status, "running");
    assert.equal(store.get(task.id).worktree, "/preserved/worktree");
  } finally {
    engine.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("YOLO cannot recover a preserved worktree while an interruption gate is open", async () => {
  const dir = await testFixture("looproom-interruption-judge-");
  const store = new Store(join(dir, "db"));
  const runtime = new FixtureRuntime();
  const engine = new Engine(store, runtime as unknown as Runtime, dir);
  try {
    store.put("settings", { concurrency: 1, subagent: { model: "gpt-6-sol", effort: "medium" } }, "settings");
    const project = store.put("project", { status: "running", escalationMode: "yolo", planned: true });
    const task = store.put("task", { projectId: project.id, status: "blocked", worktree: dir });
    const decision = store.put("gate", { projectId: project.id, taskId: task.id, type: "decision", status: "open" });
    store.put("gate", { projectId: project.id, taskId: task.id, type: "interrupted", status: "open" });
    engine.tick();
    assert.equal(runtime.profiles.length, 0);
    await engine.judge(project, decision);
    assert.equal(runtime.profiles.length, 0);
    const assessment = { action: "wait" as const, answer: "Wait", summary: "Wait", sources: [], verificationRequests: [] };
    const result = await engine.recoverEscalation(project, decision, task, assessment);
    assert.equal(result, assessment);
    assert.equal(runtime.profiles.length, 0);
  } finally {
    engine.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart gates interrupted YOLO worktree recovery until a human resolves it", async () => {
  const dir = await testFixture("looproom-yolo-restart-");
  const path = join(dir, "db");
  let store = new Store(path);
  let engine: Engine | undefined;
  try {
    store.put("settings", { concurrency: 1, subagent: { model: "gpt-6-sol", effort: "medium" } }, "settings");
    const project = store.put("project", { status: "running", escalationMode: "yolo", planned: true });
    const task = store.put("task", { projectId: project.id, status: "blocked", worktree: "/preserved/worktree" });
    const decision = store.put("gate", {
      projectId: project.id, taskId: task.id, type: "decision", status: "open",
      judgeStatus: "running", judgeRecoveryStatus: "running",
    });
    const judgeRun = store.put("run", {
      projectId: project.id, taskId: task.id, role: "judge", status: "running",
    });
    store.close();
    store = new Store(path);
    store.recover();
    store.close();
    store = new Store(path);
    store.recover();
    const interruptions = store.all("gate", project.id).filter((gate) => gate.type === "interrupted");
    assert.equal(interruptions.length, 1);
    assert.equal(store.get(project.id).status, "paused");
    assert.equal(store.get(task.id).status, "blocked");
    assert.equal(store.get(task.id).worktree, "/preserved/worktree");
    assert.equal(store.get(judgeRun.id).status, "interrupted");
    assert.equal(store.get(decision.id).judgeRecoveryStatus, "interrupted");
    const runtime = new FixtureRuntime();
    engine = new Engine(store, runtime as unknown as Runtime, dir);
    engine.tick();
    await engine.judge(store.get(project.id), store.get(decision.id));
    const assessment = { action: "wait" as const, answer: "Wait", summary: "Wait", sources: [], verificationRequests: [] };
    assert.equal(await engine.recoverEscalation(store.get(project.id), store.get(decision.id), store.get(task.id), assessment), assessment);
    assert.equal(runtime.profiles.length, 0);
    await engine.resolve(decision.id, "Continue after review", true);
    assert.equal(store.get(project.id).status, "paused");
    await assert.rejects(engine.resolve(interruptions[0].id, "retry", true, "judge"), /human resolution/);
    assert.equal(runtime.profiles.length, 0);
    await engine.resolve(interruptions[0].id, "I reviewed the preserved worktree; stop this task", false);
    assert.equal(store.get(project.id).status, "running");
    assert.equal(store.get(task.id).status, "cancelled");
    assert.equal(store.get(task.id).worktree, "/preserved/worktree");
    assert.equal(runtime.profiles.length, 0);
  } finally {
    engine?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("judge-only YOLO restart pauses dispatch until human recovery", async () => {
  const dir = await testFixture("looproom-yolo-judge-only-restart-");
  const path = join(dir, "db");
  let store = new Store(path);
  let engine: Engine | undefined;
  try {
    store.put("settings", { concurrency: 1, subagent: { model: "gpt-6-sol", effort: "medium" } }, "settings");
    const project = store.put("project", { status: "running", escalationMode: "yolo", planned: true });
    const task = store.put("task", { projectId: project.id, status: "blocked", worktree: "/preserved/worktree" });
    const decision = store.put("gate", {
      projectId: project.id, taskId: task.id, type: "decision", status: "open",
      judgeStatus: "running",
    });
    const judgeRun = store.put("run", {
      projectId: project.id, taskId: task.id, role: "judge", status: "running",
    });
    store.close();
    store = new Store(path);
    store.recover();
    store.close();
    store = new Store(path);
    store.recover();
    const interruptions = store.all("gate", project.id).filter((gate) => gate.type === "interrupted");
    assert.equal(interruptions.length, 1);
    assert.equal(store.get(judgeRun.id).status, "interrupted");
    assert.equal(store.get(project.id).status, "paused");
    assert.equal(store.get(task.id).status, "blocked");
    assert.equal(store.get(task.id).worktree, "/preserved/worktree");
    const runtime = new FixtureRuntime();
    engine = new Engine(store, runtime as unknown as Runtime, dir);
    engine.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.profiles.length, 0);
    await engine.resolve(decision.id, "Review this decision after restart", true);
    engine.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.get(project.id).status, "paused");
    assert.equal(runtime.profiles.length, 0);
    await assert.rejects(engine.resolve(interruptions[0].id, "retry", true, "judge"), /human resolution/);
    await engine.resolve(interruptions[0].id, "I reviewed the preserved worktree; stop this task", false);
    assert.equal(store.get(project.id).status, "running");
    assert.equal(store.get(task.id).status, "cancelled");
    assert.equal(store.get(task.id).worktree, "/preserved/worktree");
  } finally {
    engine?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("planner → isolated worker → check → reviewer preserves artifacts and gates a missing GitHub remote", async () => {
  const dir = await testFixture("looproom-engine-");
  const store = new Store(join(dir, "db"));
  const runtime = new FixtureRuntime();
  runtime.home = join(dir, "codex");
  // Test transport only. Sandbox enforcement is verified separately against the native CLI.
  runtime.binary = join(dir, "fixture-check");
  await writeFile(runtime.binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const engine = new Engine(store, runtime as unknown as Runtime, dir);
  // This fixture tests coordinator handoffs. Native isolation is exercised by
  // sandbox.test.ts and verification.test.ts, outside this mock runtime.
  engine.verificationRunner = async ({ cwd, commands }) => {
    assert.deepEqual(commands, ["test -f result.txt"]);
    assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "useful work");
    return {
      id: "fixture-check", sourceHash: "fixture-source", sourceUnchanged: true,
      reportPath: "fixture-check.json", createdAt: new Date().toISOString(),
      results: [{ command: commands[0], code: 0, output: "Fixture content verified", timedOut: false, durationMs: 1 }],
    };
  };
  try {
    store.put(
      "settings",
      {
        orchestrator: { model: "gpt-6.1-sol", effort: "high" },
        subagent: { model: "gpt-6-sol", effort: "medium" },
        concurrency: 2,
      },
      "settings",
    );
    const repo = await createRepo(join(dir, "repo"));
    const project = store.put("project", {
      ...repo,
      goal: "Write a useful fixture",
      constraints: "",
      checks: ["test -f result.txt"],
      status: "running",
    });
    await engine.plan(project);
    const task = store.all("task", project.id)[0];
    await engine.implement(store.get(project.id), task);
    const updated = store.get(task.id);
    assert.equal(
      await readFile(join(updated.worktree, "result.txt"), "utf8"),
      "useful work",
    );
    assert.equal(updated.status, "blocked");
    assert.equal(updated.review.verdict, "pass");
    assert.equal(store.all("gate", project.id)[0].type, "github");
    assert.equal(store.all("approval").length, 0);
    assert.deepEqual(runtime.profiles, [
      "gpt-6.1-sol/high",
      "gpt-6-sol/medium",
      "gpt-6-sol/medium",
    ]);
    const pages = store.all("memory", project.id);
    assert.equal(pages.length, 3);
    assert.match(
      await readFile(join(dir, "wiki", project.id, "index.md"), "utf8"),
      /implementation outcome/,
    );
    await engine.resolve(
      store.all("gate", project.id)[0].id,
      "Keep the existing worktree for retry.",
      true,
    );
    assert.equal(store.get(task.id).worktree, updated.worktree);
    assert.equal(store.get(task.id).status, "ready");
  } finally {
    engine.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("routine verification failures get bounded autonomous repair before human escalation", async () => {
  const dir = await testFixture("looproom-repair-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(
    store,
    new FixtureRuntime() as unknown as Runtime,
    dir,
  );
  try {
    const project = store.put("project", { status: "running" });
    const task = store.put("task", { projectId: project.id, attempt: 1 });
    engine.repairOrGate(
      project,
      task,
      "Check failed",
      "Expected output was missing.",
      "check",
    );
    assert.equal(store.get(task.id).status, "ready");
    assert.equal(store.all("gate").length, 0);
    store.patch(task.id, { attempt: 3 });
    engine.repairOrGate(
      project,
      task,
      "Check failed",
      "Still missing.",
      "check",
    );
    assert.equal(store.get(task.id).status, "blocked");
    assert.equal(store.all("gate").length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
