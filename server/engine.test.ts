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

const reviewedSha = "a".repeat(40);
function mergeFixture(store: Store) {
  const project = store.put("project", { github: "example/repo", status: "running" });
  const task = store.put("task", { projectId: project.id, status: "awaiting_human" });
  const gate = store.put("gate", {
    projectId: project.id, taskId: task.id, type: "pr", status: "open",
    pr: "https://github.com/example/repo/pull/7", sha: reviewedSha,
    title: "Review pull request", detail: "Review revision", createdAt: new Date().toISOString(),
  });
  return { project, task, gate };
}
function prState(overrides: Record<string, any> = {}) {
  return {
    number: 7, url: "https://github.com/example/repo/pull/7",
    headRefOid: reviewedSha, state: "OPEN", mergeable: "MERGEABLE", mergedAt: null,
    statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    ...overrides,
  };
}

test("broker boundary rejects missing approval, stale head, closed PR, conflicts and checks", async () => {
  const dir = await testFixture("looproom-merge-preflight-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, new FixtureRuntime() as unknown as Runtime, dir);
  const { gate } = mergeFixture(store);
  let state = prState();
  let puts = 0;
  engine.mergeBroker = async (args) => {
    if (args[0] === "pr") return JSON.stringify(state);
    puts++;
    return JSON.stringify({ merged: true, sha: "b".repeat(40) });
  };
  try {
    await assert.rejects(engine.approve(gate.id, "b".repeat(40)), /displayed revision/);
    for (const [patch, pattern] of [
      [{ headRefOid: "b".repeat(40) }, /revision changed/],
      [{ state: "CLOSED" }, /not open/],
      [{ mergeable: "CONFLICTING" }, /conflicts/],
      [{ statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] }, /pending/],
      [{ statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }] }, /failing/],
    ] as const) {
      state = prState(patch);
      await assert.rejects(engine.approve(gate.id, reviewedSha), pattern);
    }
    assert.equal(puts, 0);
    assert.equal(store.all("approval").length, 0);
    assert.equal(store.get(gate.id).mergeAttempt, undefined);
  } finally {
    engine.close(); store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent and replayed approvals submit only the reviewed SHA once", async () => {
  const dir = await testFixture("looproom-merge-race-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, new FixtureRuntime() as unknown as Runtime, dir);
  const { gate, task } = mergeFixture(store);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let puts = 0;
  engine.mergeBroker = async (args) => {
    if (args[0] === "pr") return JSON.stringify(prState());
    puts++;
    assert.equal(args[3], "repos/example/repo/pulls/7/merge");
    assert.deepEqual(args.slice(-4), ["-f", "sha=" + reviewedSha, "-f", "merge_method=squash"]);
    await pending;
    return JSON.stringify({ merged: true, sha: "b".repeat(40) });
  };
  try {
    const first = engine.approve(gate.id, reviewedSha);
    // Both preflights may finish; only one can reserve the durable intent.
    await assert.rejects(engine.approve(gate.id, reviewedSha), /no longer open|already has a merge attempt/);
    release();
    await first;
    await assert.rejects(engine.approve(gate.id, reviewedSha), /no longer open/);
    assert.equal(puts, 1);
    assert.equal(store.get(task.id).status, "completed");
    assert.equal(store.all("approval").length, 1);
    assert.equal(store.all("approval")[0].reviewedSha, reviewedSha);
  } finally {
    release(); engine.close(); store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("restart reconciles interrupted merge intent without replay or invented approval", async () => {
  for (const remoteState of ["OPEN", "MERGED", "CLOSED"]) {
    const dir = await testFixture("looproom-merge-restart-");
    let store = new Store(join(dir, "db"));
    const { gate, task } = mergeFixture(store);
    store.patch(gate.id, {
      status: "merging",
      mergeAttempt: { reviewedSha, pr: gate.pr, number: 7, requestedAt: new Date().toISOString() },
    });
    store.close();
    store = new Store(join(dir, "db"));
    store.recover();
    const engine = new Engine(store, new FixtureRuntime() as unknown as Runtime, dir);
    let puts = 0;
    engine.mergeBroker = async (args) => {
      if (args[0] === "pr") return JSON.stringify(prState({ state: remoteState, mergeCommit: { oid: "b".repeat(40) } }));
      puts++; return "";
    };
    try {
      await engine.reconcileMerges();
      const recovered = store.get(gate.id);
      assert.equal(recovered.mergeAttempt.reviewedSha, reviewedSha);
      assert.equal(recovered.status, remoteState === "MERGED" ? "reconciled" : "open");
      assert.equal(store.get(task.id).status, remoteState === "MERGED" ? "completed" : "awaiting_human");
      assert.equal(store.all("approval").length, 0);
      await assert.rejects(engine.approve(gate.id, reviewedSha), /no longer open|manual reconciliation/);
      assert.equal(puts, 0);
    } finally {
      engine.close(); store.close(); await rm(dir, { recursive: true, force: true });
    }
  }
});

test("lost broker response keeps durable intent and does not permit a second merge", async () => {
  const dir = await testFixture("looproom-merge-uncertain-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, new FixtureRuntime() as unknown as Runtime, dir);
  const { gate } = mergeFixture(store);
  let puts = 0;
  engine.mergeBroker = async (args) => {
    if (args[0] === "pr") return JSON.stringify(prState());
    puts++;
    throw new Error("connection lost after PUT");
  };
  try {
    await assert.rejects(engine.approve(gate.id, reviewedSha), /connection lost/);
    assert.equal(store.get(gate.id).status, "open");
    assert.equal(store.get(gate.id).mergeAttempt.reviewedSha, reviewedSha);
    await assert.rejects(engine.approve(gate.id, reviewedSha), /manual reconciliation/);
    assert.equal(puts, 1);
    assert.equal(store.all("approval").length, 0);
  } finally {
    engine.close(); store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("request changes cannot release a PR gate with an uncertain merge attempt", async () => {
  const dir = await testFixture("looproom-merge-request-changes-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, new FixtureRuntime() as unknown as Runtime, dir);
  const { gate, task } = mergeFixture(store);
  let puts = 0;
  engine.mergeBroker = async (args) => {
    if (args[0] === "pr") return JSON.stringify(prState());
    puts++;
    throw new Error("merge response lost");
  };
  try {
    await assert.rejects(engine.approve(gate.id, reviewedSha), /merge response lost/);
    for (const retry of [true, false]) {
      await assert.rejects(
        engine.resolve(gate.id, "Request changes before merging", retry),
        /Reconcile the outstanding merge attempt/,
      );
    }
    assert.equal(store.get(gate.id).status, "open");
    assert.equal(store.get(gate.id).mergeAttempt.reviewedSha, reviewedSha);
    assert.equal(store.get(task.id).status, "awaiting_human");
    assert.equal(store.all("approval").length, 0);
    assert.equal(puts, 1);
  } finally {
    engine.close(); store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("merge target stays bound to reviewed PR when project origin changes", async () => {
  const dir = await testFixture("looproom-merge-origin-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, new FixtureRuntime() as unknown as Runtime, dir);
  const { gate, project } = mergeFixture(store);
  store.patch(project.id, { github: "other/repo" });
  const targets: string[] = [];
  engine.mergeBroker = async (args) => {
    if (args[0] === "pr") return JSON.stringify(prState());
    targets.push(args[3]);
    return JSON.stringify({ merged: true, sha: "b".repeat(40) });
  };
  try {
    await engine.approve(gate.id, reviewedSha);
    assert.deepEqual(targets, ["repos/example/repo/pulls/7/merge"]);
  } finally {
    engine.close(); store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("human recovery archives changed-head and closed-unmerged attempts for Request changes", async () => {
  for (const [remote, recoveryText] of [
    [prState({ headRefOid: "c".repeat(40) }), /different PR head/],
    [prState({ state: "CLOSED", mergeCommit: null }), /closed without a merge/],
  ] as const) {
    const dir = await testFixture("looproom-merge-manual-recovery-");
    const store = new Store(join(dir, "db"));
    const engine = new Engine(store, new FixtureRuntime() as unknown as Runtime, dir);
    const { gate, task } = mergeFixture(store);
    let state = prState();
    let puts = 0;
    engine.mergeBroker = async (args) => {
      if (args[0] === "pr") return JSON.stringify(state);
      puts++;
      throw new Error("response lost");
    };
    try {
      await assert.rejects(engine.approve(gate.id, reviewedSha), /response lost/);
      const attempt = store.get(gate.id).mergeAttempt;
      state = remote;
      await engine.reconcileMerge(gate.id, true);
      const recovered = store.get(gate.id);
      assert.equal(recovered.status, "open");
      assert.equal(recovered.mergeAttempt, null);
      assert.deepEqual(recovered.mergeAttempts, [attempt]);
      assert.match(recovered.mergeRecovery, recoveryText);
      assert.equal(store.get(task.id).status, "awaiting_human");
      assert.equal(store.all("approval").length, 0);
      assert.equal(puts, 1);
      await assert.rejects(engine.reconcileMerge(gate.id, true), /No interrupted PR merge/);
      assert.equal(store.all("approval").length, 0);
      assert.equal(puts, 1);
      await assert.rejects(
        engine.approve(gate.id, remote.headRefOid),
        /displayed revision|not open/,
      );
      assert.equal(puts, 1);
      await engine.resolve(gate.id, "Review the changed PR before retrying.", true);
      assert.equal(store.get(task.id).status, "ready");
      assert.deepEqual(store.get(gate.id).mergeAttempts, [attempt]);
      assert.equal(store.all("approval").length, 0);
      assert.equal(puts, 1);
    } finally {
      engine.close(); store.close(); await rm(dir, { recursive: true, force: true });
    }
  }
});

test("human recovery of the same open head retains history before a fresh approval", async () => {
  const dir = await testFixture("looproom-merge-same-head-recovery-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, new FixtureRuntime() as unknown as Runtime, dir);
  const { gate } = mergeFixture(store);
  let puts = 0;
  engine.mergeBroker = async (args) => {
    if (args[0] === "pr") return JSON.stringify(prState());
    puts++;
    if (puts === 1) throw new Error("response lost");
    assert.deepEqual(args.slice(-4), ["-f", "sha=" + reviewedSha, "-f", "merge_method=squash"]);
    return JSON.stringify({ merged: true, sha: "b".repeat(40) });
  };
  try {
    await assert.rejects(engine.approve(gate.id, reviewedSha), /response lost/);
    const attempt = store.get(gate.id).mergeAttempt;
    await engine.reconcileMerge(gate.id, true);
    assert.equal(store.get(gate.id).mergeAttempt, null);
    assert.deepEqual(store.get(gate.id).mergeAttempts, [attempt]);
    assert.equal(store.get(gate.id).status, "open");
    assert.equal(store.all("approval").length, 0);
    assert.equal(puts, 1);
    await engine.approve(gate.id, reviewedSha);
    assert.equal(puts, 2);
    assert.equal(store.all("approval")[0].reviewedSha, reviewedSha);
  } finally {
    engine.close(); store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("human recovery keeps intent when the PR read fails, identity changes or state is ambiguous", async () => {
  const dir = await testFixture("looproom-merge-ambiguous-recovery-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, new FixtureRuntime() as unknown as Runtime, dir);
  const { gate } = mergeFixture(store);
  store.patch(gate.id, {
    mergeAttempt: { reviewedSha, pr: gate.pr, number: 7, requestedAt: new Date().toISOString() },
  });
  let state: Record<string, any> | null = null;
  engine.mergeBroker = async () => {
    if (!state) throw new Error("read failed");
    return JSON.stringify(state);
  };
  try {
    await assert.rejects(engine.reconcileMerge(gate.id, true), /read failed/);
    for (const remote of [
      prState({ url: "https://github.com/example/repo/pull/8" }),
      prState({ state: "CLOSED", mergedAt: undefined }),
      prState({ state: "OPEN", headRefOid: null }),
    ]) {
      state = remote;
      if (remote.number === 7 && remote.url !== gate.pr)
        await assert.rejects(engine.reconcileMerge(gate.id, true), /identity changed/);
      else await engine.reconcileMerge(gate.id, true);
      assert.equal(store.get(gate.id).mergeAttempt.reviewedSha, reviewedSha);
      assert.equal(store.all("approval").length, 0);
    }
  } finally {
    engine.close(); store.close(); await rm(dir, { recursive: true, force: true });
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
