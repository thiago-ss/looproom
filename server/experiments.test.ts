import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rm, writeFile, access, mkdir } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import type { Runtime } from "./runtime.ts";
import { testFixture } from "./test-fixtures.ts";
import { startExperiment, recordCandidate, reserveCandidate, reportCandidate, finalizeCandidate, authorizeNextRound } from "./experiments.ts";
import { createRepo, createWorktree, git } from "./git.ts";
import { sourceFingerprint } from "./verification.ts";
import { z } from "zod";
import { randomUUID } from "node:crypto";

const contract = {
  evaluator: "scripts/evaluate.ts#sha256:fixed", workload: "fixture-v1",
  runtimeBudget: "60 seconds per candidate",
  thresholds: { latencyMs: 100 }, candidateLimit: 3,
};
const refreshHash = "a".repeat(64);
const refreshWorkload = "4 paused projects, 48 completed tasks, 80 events, 5 message updates";
const refreshContract = {
  evaluator: `scripts/measure-refresh.ts#sha256:${refreshHash}`,
  workload: refreshWorkload, runtimeBudget: "30 seconds",
  thresholds: { minMedianImprovementPercent: 10, maxOtherMedianRegressionPercent: 5,
    requiredChecks: "npm test" }, candidateLimit: 3,
};
function refreshReport(store: Store, projectId: string, runId: string, values: number[],
  options: { workload?: string; evaluatorHash?: string; checks?: boolean; sourceHash?: string } = {}) {
  const id = randomUUID();
  store.put("verification-report", { projectId, report: { id, runId,
    evaluatorHash: options.evaluatorHash ?? refreshHash, sourceHash: options.sourceHash ?? "source-fixed",
    sourceUnchanged: true,
    results: [{ command: "node --import tsx scripts/measure-refresh.ts", code: 0,
      timedOut: false, durationMs: 1000, output: JSON.stringify({ repetitions: 5,
        workload: options.workload ?? refreshWorkload, baselineRefreshBytes: values[0],
        baselineCoordinatorRoundTripMs: values[1], baselineUpdateLatencyMs: values[2] }) },
      ...(options.checks ? [{ command: "npm test", code: 0, timedOut: false }] : [])] } },
  `verification-report:${id}`);
  return `verification:${id}`;
}

test("planning rejects unkeepable experiments before writing tasks and accepts a frozen refresh recipe", async () => {
  const dir = await testFixture("looproom-experiment-plan-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, Object.assign(new EventEmitter(), { close() {} }) as unknown as Runtime, dir);
  try {
    const project = store.put("project", { status: "running", goal: "Improve refresh" });
    const ordinary = { title: "Independent usability work", description: "Inspect local flow",
      acceptance: ["Record findings"], dependencies: [], kind: "research" };
    const measured = { title: "Measure refresh", description: "Reduce refresh bytes",
      acceptance: ["Compare frozen medians"], dependencies: [], kind: "implementation",
      experiment: { hypothesis: "Cache unchanged records", contract: refreshContract } };
    let tasks: any[] = [];
    engine.run = async () => ({ summary: "Plan", gate: "", sources: ["scripts/measure-refresh.ts"],
      claims: [], tasks }) as any;
    const counts = () => [store.all("task", project.id).length,
      store.all("experiment-round", project.id).length];
    tasks = [ordinary, { ...measured, experiment: { ...measured.experiment,
      contract: { ...refreshContract, evaluator: "scripts/other.ts#sha256:arbitrary",
        thresholds: { latencyMs: 100 } } } }];
    await assert.rejects(engine.plan(project), /Planning rejected experiment: Only the frozen refresh evaluator/);
    assert.deepEqual(counts(), [0, 0]);
    tasks = [ordinary, measured];
    await assert.rejects(engine.plan(project), /Planning rejected experiment: Only the frozen refresh evaluator/);
    assert.deepEqual(counts(), [0, 0]);
    const baselineRun = store.put("run", { projectId: project.id, role: "implementation" });
    const source = refreshReport(store, project.id, baselineRun.id, [100, 100, 100]);
    const reportId = source.slice("verification:".length);
    store.patch(project.id, { refreshBaseline: { phase: "frozen", evaluatorHash: refreshHash,
      reportId, measurementSourceHash: "wrong-source" } });
    await assert.rejects(engine.plan(project), /Planning rejected experiment: Frozen refresh baseline needs/);
    assert.deepEqual(counts(), [0, 0]);
    store.patch(project.id, { refreshBaseline: { phase: "frozen", evaluatorHash: refreshHash,
      reportId, measurementSourceHash: "source-fixed" } });
    await engine.plan(project);
    assert.deepEqual(counts(), [2, 1]);
    assert.equal(store.all("task", project.id).find((task) => task.title === ordinary.title)?.status, "ready");
    assert.deepEqual(store.all("experiment-round", project.id)[0].contract, refreshContract);
    assert.equal(store.all("approval", project.id).length, 0);
  } finally { engine.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const pathKind of ["record", "finalize"] as const) {
  for (const scenario of ["passing", "below threshold", "other metric regresses",
    "missing report", "mismatched evaluator", "mismatched workload", "missing checks",
    "stale source", "missing reviewed source"] as const) {
    test(`${pathKind} keep decision rejects unsupported evidence: ${scenario}`, async () => {
      const dir = await testFixture(`looproom-refresh-keep-${pathKind}-`);
      const db = join(dir, "db");
      let store = new Store(db);
      try {
        const project = store.put("project", { status: "running" });
        const task = store.put("task", { projectId: project.id, status: "ready" });
        const independent = store.put("task", { projectId: project.id, status: "ready" });
        const baselineRun = store.put("run", { projectId: project.id, role: "implementation" });
        const baselineSource = refreshReport(store, project.id, baselineRun.id, [100, 100, 100]);
        store.patch(project.id, { refreshBaseline: { phase: "frozen", evaluatorHash: refreshHash,
          reportId: baselineSource.slice("verification:".length),
          measurementSourceHash: "source-fixed" } });
        const round = startExperiment(store, project.id, task.id, "Reduce refresh bytes", refreshContract);
        if (scenario !== "missing reviewed source")
          store.patch(task.id, { reviewedSource: { sourceHash: "source-fixed" } });
        const run = store.put("run", { projectId: project.id, taskId: task.id,
          role: "implementation", experimentRoundId: round.id });
        const values = scenario === "below threshold" ? [95, 100, 100] :
          scenario === "other metric regresses" ? [89, 106, 100] : [89, 100, 100];
        const source = scenario === "missing report" ? `verification:${randomUUID()}` :
          refreshReport(store, project.id, run.id, values,
            { checks: scenario !== "missing checks",
              workload: scenario === "mismatched workload" ? "different" : undefined,
              evaluatorHash: scenario === "mismatched evaluator" ? "b".repeat(64) : undefined,
              sourceHash: scenario === "stale source" ? "source-old" : undefined });
        let candidate;
        if (pathKind === "record") {
          candidate = recordCandidate(store, round.id, { runId: run.id, outcome: "keep",
            measurement: "worker says faster", evidence: [source], ...refreshContract });
        } else {
          const slot = reserveCandidate(store, round.id, run.id);
          reportCandidate(store, slot.id, { outcome: "keep", measurement: "worker says faster",
            evidence: [source], ...refreshContract });
          candidate = finalizeCandidate(store, slot.id, "keep");
          assert.throws(() => finalizeCandidate(store, slot.id, "keep"), /not pending/);
        }
        assert.equal(candidate.outcome, scenario === "passing" ? "keep" : "discard");
        assert.equal(store.get(round.id).status, scenario === "passing" ? "kept" : "active");
        if (scenario !== "passing") {
          assert.ok(candidate.rejection);
          if (["stale source", "missing reviewed source"].includes(scenario))
            assert.match(candidate.rejection, /reviewed source/);
          assert.equal(store.get(task.id).status, "ready");
          assert.equal(store.all("gate", project.id).length, 0);
        }
        store.close(); store = new Store(db);
        assert.equal(store.get(candidate.id).outcome, scenario === "passing" ? "keep" : "discard");
        if (scenario === "below threshold") {
          assert.equal(store.get(task.id).status, "ready");
          assert.equal(store.all("gate", project.id).filter((gate) => gate.status === "open").length, 0);
          const nextRun = store.put("run", { projectId: project.id, taskId: task.id,
            role: "implementation", experimentRoundId: round.id });
          if (pathKind === "finalize") {
            const next = reserveCandidate(store, round.id, nextRun.id);
            assert.equal(next.number, 2);
          }
        }
        assert.equal(store.get(independent.id).status, "ready");
        assert.equal(store.all("approval", project.id).length, 0);
      } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
    });
  }
}

for (const pathKind of ["record", "finalize"] as const) {
  test(`${pathKind} rejected final keep retains its round gate and authorizes a successor after restart`, async () => {
    const dir = await testFixture(`looproom-refresh-exhausted-${pathKind}-`);
    const db = join(dir, "db");
    let store = new Store(db);
    let engine: Engine | undefined;
    const runtime = Object.assign(new EventEmitter(), { close() {},
      async run() { return JSON.stringify({ action: "retry", answer: "Try a source cache",
        summary: "One new bounded round", sources: ["docs/workflows/looproom-v1.md"],
        nextRound: { hypothesis: "Cache unchanged source revisions",
          retryInstruction: `Implement source revision caching and measure with ${refreshWorkload}`,
          contract: refreshContract }, verificationRequests: [] }); },
    }) as unknown as Runtime;
    try {
      store.put("settings", { orchestrator: { model: "fixture", effort: "high" },
        subagent: { model: "fixture", effort: "medium" },
        judge: { model: "fixture", effort: "medium" } }, "settings");
      const project = store.put("project", { path: dir, goal: "Improve refresh", constraints: "",
        status: "running", planned: true, escalationMode: "yolo" });
      const task = store.put("task", { projectId: project.id, status: "ready",
        title: "Measure refresh", dependencies: [], acceptance: [] });
      const independent = store.put("task", { projectId: project.id, status: "ready",
        title: "Independent work", dependencies: [] });
      const baselineRun = store.put("run", { projectId: project.id, role: "implementation" });
      const baselineSource = refreshReport(store, project.id, baselineRun.id, [100, 100, 100]);
      store.patch(project.id, { refreshBaseline: { phase: "frozen", evaluatorHash: refreshHash,
        reportId: baselineSource.slice("verification:".length),
        measurementSourceHash: "source-fixed" } });
      const round = startExperiment(store, project.id, task.id, "Reduce refresh bytes", refreshContract);
      store.patch(task.id, { reviewedSource: { sourceHash: "source-fixed" } });
      for (let i = 0; i < 2; i++) {
        const run = store.put("run", { projectId: project.id, taskId: task.id,
          role: "implementation", experimentRoundId: round.id });
        recordCandidate(store, round.id, { runId: run.id, outcome: "discard",
          measurement: `${100 - i} ms`, evidence: [`measurement:prior:${i}`], ...refreshContract });
      }
      const run = store.put("run", { projectId: project.id, taskId: task.id,
        role: "implementation", experimentRoundId: round.id });
      const source = refreshReport(store, project.id, run.id, [95, 100, 100], { checks: true });
      const input = { runId: run.id, outcome: "keep" as const, measurement: "worker claimed improvement",
        evidence: [source], ...refreshContract };
      const candidate = pathKind === "record" ? recordCandidate(store, round.id, input) : (() => {
        const slot = reserveCandidate(store, round.id, run.id);
        reportCandidate(store, slot.id, input);
        return finalizeCandidate(store, slot.id, "keep");
      })();
      assert.equal(candidate.outcome, "discard");
      assert.match(candidate.rejection, /10% threshold/);
      store.close(); store = new Store(db);
      const gates = store.all("gate", project.id).filter((gate) => gate.status === "open" && gate.taskId === task.id);
      assert.equal(gates.length, 1);
      assert.equal(gates[0].type, "experiment");
      assert.equal(gates[0].experimentRoundId, round.id);
      assert.equal(store.get(round.id).status, "exhausted");
      assert.equal(store.get(task.id).status, "blocked");
      assert.equal(store.get(candidate.id).measurement, input.measurement);
      engine = new Engine(store, runtime, dir);
      await engine.judge(store.get(project.id), gates[0]);
      assert.equal(store.get(gates[0].id).status, "resolved", store.get(gates[0].id).judgeError);
      const successor = store.get(store.get(round.id).nextRoundId, "experiment-round");
      assert.deepEqual(successor.contract, refreshContract);
      assert.equal(store.get(task.id).experimentRoundId, successor.id);
      assert.equal(store.get(task.id).status, "ready");
      assert.equal(store.get(round.id).candidateIds.length, 3);
      assert.equal(store.get(candidate.id).outcome, "discard");
      assert.equal(store.get(independent.id).status, "ready");
      assert.equal(store.all("approval", project.id).length, 0);
    } finally { engine?.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test("below-threshold measured run stays ready for another slot and cannot publish", async () => {
  const dir = await testFixture("looproom-refresh-no-publish-");
  const repo = await createRepo(join(dir, "repo"));
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, Object.assign(new EventEmitter(), { close() {} }) as Runtime, dir);
  try {
    const project = store.put("project", { path: repo.path, branch: repo.branch,
      status: "running", goal: "Refresh faster", constraints: "", checks: ["npm test"] });
    const task = store.put("task", { projectId: project.id, status: "ready", kind: "implementation",
      title: "Measure candidate", description: "", acceptance: [], dependencies: [], attempt: 0 });
    const independent = store.put("task", { projectId: project.id, status: "ready", dependencies: [] });
    const tree = await createWorktree(repo.path, dir, task.id);
    store.patch(task.id, { worktree: tree.path });
    const baselineRun = store.put("run", { projectId: project.id, role: "implementation" });
    const baselineSource = refreshReport(store, project.id, baselineRun.id, [100, 100, 100]);
    store.patch(project.id, { refreshBaseline: { phase: "frozen", evaluatorHash: refreshHash,
      reportId: baselineSource.slice("verification:".length), measurementSourceHash: "source-fixed",
      ownerTaskId: task.id } });
    const round = startExperiment(store, project.id, task.id, "Reduce refresh bytes", refreshContract);
    engine.run = async (_project, role) => {
      if (role === "review") return { verdict: "pass", summary: "Reviewed", sources: [] } as any;
      const run = store.put("run", { projectId: project.id, taskId: task.id,
        role: "implementation", experimentRoundId: round.id, status: "completed" });
      const slot = reserveCandidate(store, round.id, run.id);
      store.patch(run.id, { experimentCandidateId: slot.id });
      store.patch(task.id, { implementationRunId: run.id });
      const source = refreshReport(store, project.id, run.id, [95, 100, 100], { checks: true });
      const result = { outcome: "keep" as const, measurement: "worker claimed improvement",
        evidence: [source], ...refreshContract };
      reportCandidate(store, slot.id, result);
      return { summary: "Candidate", sources: [source], humanQuestion: "", experimentCandidate: result } as any;
    };
    engine.verify = async () => ({ id: randomUUID(), sourceHash: await sourceFingerprint(tree.path),
      sourceUnchanged: true, results: [{ command: "npm test", code: 0 }] }) as any;
    let publications = 0;
    engine.publish = async () => { publications++; };
    await engine.implement(store.get(project.id), store.get(task.id));
    assert.equal(publications, 0);
    assert.equal(store.get(store.get(round.id).candidateIds[0]).outcome, "discard");
    assert.equal(store.get(task.id).status, "ready");
    assert.equal(store.all("gate", project.id).length, 0);
    assert.equal(store.get(independent.id).status, "ready");
    assert.equal(store.all("approval", project.id).length, 0);
  } finally { engine.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const finalCheckSource of ["reviewed", "stale"] as const) {
  test(`source A measurement cannot publish source B with ${finalCheckSource} final checks`, async () => {
    const dir = await testFixture(`looproom-refresh-source-binding-${finalCheckSource}-`);
    const repo = await createRepo(join(dir, "repo"));
    const db = join(dir, "db");
    let store = new Store(db);
    let engine: Engine | undefined;
    try {
      const project = store.put("project", { path: repo.path, branch: repo.branch,
        status: "running", goal: "Refresh faster", constraints: "", checks: ["npm test"] });
      const task = store.put("task", { projectId: project.id, status: "ready", kind: "implementation",
        title: "Measure candidate", description: "", acceptance: [], dependencies: [], attempt: 0 });
      const independent = store.put("task", { projectId: project.id, status: "ready", dependencies: [] });
      const tree = await createWorktree(repo.path, dir, task.id);
      store.patch(task.id, { worktree: tree.path });
      const baselineRun = store.put("run", { projectId: project.id, role: "implementation" });
      const baselineSource = refreshReport(store, project.id, baselineRun.id, [100, 100, 100]);
      store.patch(project.id, { refreshBaseline: { phase: "frozen", evaluatorHash: refreshHash,
        reportId: baselineSource.slice("verification:".length), measurementSourceHash: "source-fixed" } });
      const round = startExperiment(store, project.id, task.id, "Reduce refresh bytes", refreshContract);
      engine = new Engine(store, Object.assign(new EventEmitter(), { close() {} }) as Runtime, dir);
      let measuredSourceHash = "";
      let reviewCount = 0, publications = 0;
      engine.run = async (_project, role) => {
        if (role === "review") {
          reviewCount++;
          return { verdict: "pass", summary: "Reviewed source B", sources: [] } as any;
        }
        const run = store.put("run", { projectId: project.id, taskId: task.id,
          role: "implementation", experimentRoundId: round.id, status: "completed" });
        const slot = reserveCandidate(store, round.id, run.id);
        store.patch(run.id, { experimentCandidateId: slot.id });
        store.patch(task.id, { implementationRunId: run.id });
        await writeFile(join(tree.path, "candidate.txt"), "source A");
        measuredSourceHash = await sourceFingerprint(tree.path);
        const source = refreshReport(store, project.id, run.id, [89, 100, 100],
          { checks: true, sourceHash: measuredSourceHash });
        const measured = { outcome: "keep" as const, measurement: "89 bytes",
          evidence: [source], ...refreshContract };
        reportCandidate(store, slot.id, measured);
        await writeFile(join(tree.path, "candidate.txt"), "source B");
        return { summary: "Measured A, submitted B", sources: [source],
          humanQuestion: "", experimentCandidate: measured } as any;
      };
      engine.verify = async () => ({ id: randomUUID(),
        sourceHash: finalCheckSource === "stale" ? measuredSourceHash : await sourceFingerprint(tree.path),
        sourceUnchanged: true, results: [{ command: "npm test", code: 0 }] }) as any;
      engine.publish = async () => { publications++; };
      await engine.implement(store.get(project.id), store.get(task.id));
      const candidateId = store.get(round.id).candidateIds[0];
      const candidate = store.get(candidateId);
      assert.equal(candidate.outcome, "discard");
      assert.equal(candidate.reportedOutcome, "keep");
      assert.equal(candidate.measurement, "89 bytes");
      assert.equal(store.get(candidate.runId).experimentCandidateId, candidateId);
      assert.notEqual(await sourceFingerprint(tree.path), measuredSourceHash);
      assert.match(candidate.rejection, finalCheckSource === "stale"
        ? /Source changed during verification/ : /reviewed source/);
      assert.equal(reviewCount, finalCheckSource === "reviewed" ? 1 : 0);
      assert.equal(publications, 0);
      assert.equal(store.get(task.id).status, "ready");
      assert.equal(store.get(independent.id).status, "ready");
      assert.deepEqual(store.get(round.id).contract, refreshContract);
      assert.equal(store.all("approval", project.id).length, 0);
      engine.close(); engine = undefined;
      store.close(); store = new Store(db);
      assert.equal(store.get(candidateId).outcome, "discard");
      assert.equal(store.get(candidateId).evidence[0], candidate.evidence[0]);
      assert.equal(store.get(`verification-report:${candidate.evidence[0].slice("verification:".length)}`).report.sourceHash,
        measuredSourceHash);
      assert.equal(store.get(round.id).status, "active");
      assert.equal(store.all("approval", project.id).length, 0);
    } finally { engine?.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test("experiment rounds persist across restart and keep exhausted outcomes immutable", async () => {
  const dir = await testFixture("looproom-experiment-restart-");
  const path = join(dir, "db");
  let store = new Store(path);
  try {
    const project = store.put("project", { status: "running", escalationMode: "yolo" });
    const task = store.put("task", { projectId: project.id, status: "ready" });
    const independent = store.put("task", { projectId: project.id, status: "ready" });
    const first = startExperiment(store, project.id, task.id, "Reduce refresh time", contract);
    for (let i = 0; i < 3; i++) {
      const run = store.put("run", { projectId: project.id, taskId: task.id, role: "implementation", experimentRoundId: first.id });
      recordCandidate(store, first.id, { runId: run.id, outcome: "discard", measurement: `${110 - i} ms`,
        evidence: [`report:${i}`], evaluator: contract.evaluator, workload: contract.workload,
        runtimeBudget: contract.runtimeBudget, thresholds: contract.thresholds });
    }
    assert.equal(store.get(first.id).status, "exhausted");
    assert.equal(store.get(independent.id).status, "ready");
    store.close();
    store = new Store(path);
    const judge = store.put("run", { projectId: project.id, taskId: task.id, role: "judge" });
    const second = authorizeNextRound(store, first.id, judge.id, "Avoid redundant serialization",
      "Try caching only unchanged records; measure with fixture-v1", contract);
    assert.notEqual(second.id, first.id);
    assert.equal(second.number, 2);
    assert.equal(store.get(first.id).candidateIds.length, 3);
    assert.equal(store.get(first.id).status, "exhausted");
    assert.equal(store.get(task.id).experimentRoundId, second.id);
    assert.match(store.get(task.id).feedback, /caching only unchanged records/);
    assert.equal(store.get(independent.id).status, "ready");
    assert.equal(store.all("approval", project.id).length, 0);
    await assert.rejects(async () => authorizeNextRound(store, first.id, judge.id,
      "Duplicate", "Repeat", contract), /Only one judge-authorized/);
    store.close();
    store = new Store(path);
    assert.equal(store.get(first.id).nextRoundId, second.id);
    assert.equal(store.get(second.id).contract.evaluator, contract.evaluator);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate and next-round contracts reject drift and candidate overflow", async () => {
  const dir = await testFixture("looproom-experiment-contract-");
  const store = new Store(join(dir, "db"));
  try {
    const project = store.put("project", { status: "running" });
    const task = store.put("task", { projectId: project.id });
    const round = startExperiment(store, project.id, task.id, "Test hypothesis", contract);
    const run = store.put("run", { projectId: project.id, taskId: task.id, role: "implementation", experimentRoundId: round.id });
    const input = { runId: run.id, outcome: "discard" as const, measurement: "120 ms",
      evidence: ["report:1"], evaluator: contract.evaluator, workload: contract.workload,
      runtimeBudget: contract.runtimeBudget, thresholds: contract.thresholds };
    assert.throws(() => recordCandidate(store, round.id, { ...input, evaluator: "changed" }), /differ/);
    assert.throws(() => recordCandidate(store, round.id, { ...input, runtimeBudget: "120 seconds" }), /differ/);
    assert.throws(() => recordCandidate(store, round.id, { ...input, thresholds: { latencyMs: 200 } }), /differ/);
    assert.equal(store.get(round.id).candidateIds.length, 0);
    recordCandidate(store, round.id, input);
    assert.throws(() => recordCandidate(store, round.id, input), /already has/);
    for (let i = 0; i < 2; i++) {
      const nextRun = store.put("run", { projectId: project.id, taskId: task.id, role: "implementation", experimentRoundId: round.id });
      recordCandidate(store, round.id, { ...input, runId: nextRun.id });
    }
    const extra = store.put("run", { projectId: project.id, taskId: task.id, role: "implementation", experimentRoundId: round.id });
    assert.throws(() => recordCandidate(store, round.id, { ...input, runId: extra.id }), /active experiment round/);
    const judge = store.put("run", { projectId: project.id, taskId: task.id, role: "judge" });
    assert.throws(() => authorizeNextRound(store, round.id, judge.id, "Next", "Retry",
      { ...contract, workload: "different" }), /preserve evaluator/);
    assert.throws(() => authorizeNextRound(store, round.id, judge.id, "Next", "Retry",
      { ...contract, runtimeBudget: "120 seconds" }), /preserve evaluator/);
    assert.equal(store.all("experiment-round", project.id).length, 1);
    assert.equal(store.all("approval", project.id).length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("successor needs a distinct hypothesis and a change with a measurement plan", async () => {
  const dir = await testFixture("looproom-experiment-distinct-");
  const path = join(dir, "db");
  let store = new Store(path);
  try {
    const project = store.put("project", { status: "running", escalationMode: "yolo" });
    const task = store.put("task", { projectId: project.id, status: "blocked" });
    const independent = store.put("task", { projectId: project.id, status: "ready" });
    const first = startExperiment(store, project.id, task.id, "Reduce refresh time", contract);
    for (let i = 0; i < 3; i++) {
      const run = store.put("run", { projectId: project.id, taskId: task.id,
        role: "implementation", experimentRoundId: first.id });
      recordCandidate(store, first.id, { runId: run.id, outcome: "discard", measurement: `${120 - i} ms`,
        evidence: [`report:${i}`], ...contract });
    }
    store.close(); store = new Store(path);
    const judge = store.put("run", { projectId: project.id, taskId: task.id, role: "judge" });
    assert.throws(() => authorizeNextRound(store, first.id, judge.id, " REDUCE, refresh time! ",
      "Cache unchanged records and measure with fixture-v1", contract), /distinct/);
    for (const instruction of ["Retry", "Try again", "Implement changes and measure results again"])
      assert.throws(() => authorizeNextRound(store, first.id, judge.id, "Cache unchanged records",
        instruction, contract), /specific change/);
    assert.equal(store.all("experiment-round", project.id).length, 1);
    assert.equal(store.get(first.id).candidateIds.length, 3);
    assert.equal(store.get(first.id).status, "exhausted");
    assert.equal(store.get(task.id).experimentRoundId, first.id);
    assert.equal(store.get(independent.id).status, "ready");
    assert.equal(store.all("approval", project.id).length, 0);
    const second = authorizeNextRound(store, first.id, judge.id, "Cache unchanged source revisions",
      "Cache unchanged records and measure with fixture-v1", contract);
    assert.equal(second.previousRoundId, first.id);
    assert.equal(store.get(first.id).candidateIds.length, 3);
    assert.equal(store.get(independent.id).status, "ready");
    assert.equal(store.all("approval", project.id).length, 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a prior-round implementation run cannot be attached to its successor after restart", async () => {
  const dir = await testFixture("looproom-experiment-run-round-");
  const path = join(dir, "db");
  let store = new Store(path);
  try {
    const project = store.put("project", { status: "running", escalationMode: "yolo" });
    const task = store.put("task", { projectId: project.id, status: "blocked" });
    const independent = store.put("task", { projectId: project.id, status: "ready" });
    const first = startExperiment(store, project.id, task.id, "Reduce refresh time", contract);
    const oldRun = store.put("run", { projectId: project.id, taskId: task.id,
      role: "implementation", experimentRoundId: first.id });
    for (let i = 0; i < 3; i++) {
      const run = i === 0 ? oldRun : store.put("run", { projectId: project.id, taskId: task.id,
        role: "implementation", experimentRoundId: first.id });
      recordCandidate(store, first.id, { runId: run.id, outcome: "discard", measurement: `${120 - i} ms`,
        evidence: [`report:${i}`], ...contract });
    }
    const judge = store.put("run", { projectId: project.id, taskId: task.id, role: "judge" });
    const second = authorizeNextRound(store, first.id, judge.id, "Cache unchanged records",
      "Cache unchanged records and measure with fixture-v1", contract);
    store.close(); store = new Store(path);
    const input = { outcome: "discard" as const, measurement: "90 ms", evidence: ["report:new"], ...contract };
    assert.throws(() => recordCandidate(store, second.id, { ...input, runId: oldRun.id }), /active experiment round/);
    const unstamped = store.put("run", { projectId: project.id, taskId: task.id, role: "implementation" });
    assert.throws(() => recordCandidate(store, second.id, { ...input, runId: unstamped.id }), /active experiment round/);
    assert.equal(store.get(first.id).candidateIds.length, 3);
    assert.equal(store.get(first.id).status, "exhausted");
    assert.deepEqual(store.get(second.id).candidateIds, []);
    assert.equal(store.get(second.id).status, "active");
    assert.equal(store.get(independent.id).status, "ready");
    assert.equal(store.all("approval", project.id).length, 0);
    const currentRun = store.put("run", { projectId: project.id, taskId: task.id,
      role: "implementation", experimentRoundId: second.id });
    recordCandidate(store, second.id, { ...input, runId: currentRun.id });
    assert.equal(store.get(second.id).candidateIds.length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("experiment retry requires atomic judge authorization across restart", async () => {
  const roundContract = refreshContract;
  const dir = await testFixture("looproom-experiment-atomic-");
  const path = join(dir, "db");
  let store = new Store(path);
  let engine: Engine | undefined;
  const runtime = Object.assign(new EventEmitter(), {
    close() {},
    async run() { return JSON.stringify({ action: "retry", answer: "Try a source cache",
      summary: "One new bounded round", sources: ["docs/workflows/looproom-v1.md"],
      nextRound: { hypothesis: "Cache unchanged source revisions",
        retryInstruction: "Implement source revision caching and measure 4 paused projects, 48 completed tasks, 80 events, 5 message updates",
        contract: roundContract }, verificationRequests: [] }); },
  }) as unknown as Runtime;
  try {
    store.put("settings", { orchestrator: { model: "fixture", effort: "high" },
      subagent: { model: "fixture", effort: "medium" },
      judge: { model: "fixture", effort: "medium" } }, "settings");
    const project = store.put("project", { path: dir, goal: "Improve refresh", constraints: "",
      status: "running", planned: true, escalationMode: "yolo" });
    const task = store.put("task", { projectId: project.id, status: "ready", title: "Measure refresh",
      dependencies: [], acceptance: [] });
    const independent = store.put("task", { projectId: project.id, status: "ready",
      title: "Independent work", dependencies: [] });
    const round = startExperiment(store, project.id, task.id, "Reduce refresh time", roundContract);
    for (let i = 0; i < 3; i++) {
      const run = store.put("run", { projectId: project.id, taskId: task.id, role: "implementation", experimentRoundId: round.id });
      recordCandidate(store, round.id, { runId: run.id, outcome: "discard", measurement: `${120 - i} ms`,
        evidence: [`report:${i}`], evaluator: roundContract.evaluator, workload: roundContract.workload,
        runtimeBudget: roundContract.runtimeBudget, thresholds: roundContract.thresholds });
    }
    engine = new Engine(store, runtime, dir);
    const gate = engine.gate(project.id, "Experiment round exhausted", "Three candidates discarded",
      "experiment", task.id, { experimentRoundId: round.id });
    store.patch(task.id, { attempt: 3, judgeRetries: 3 });
    await assert.rejects(engine.resolve(gate.id, "Retry", true), /judge authorization/);
    assert.equal(store.get(task.id).status, "blocked");

    // Fail after the successor has been inserted. SQLite must roll back that insert
    // together with the draft and gate resolution.
    const original = store.recordGateResponse.bind(store);
    (store as any).recordGateResponse = (...args: any[]) => {
      if (args[5] === "escalation_draft") throw new Error("injected draft write failure");
      return (original as any)(...args);
    };
    await engine.judge(store.get(project.id), store.get(gate.id));
    (store as any).recordGateResponse = original;
    assert.equal(store.get(gate.id).status, "open", store.get(gate.id).judgeError);
    assert.match(store.get(gate.id).judgeError, /injected draft write failure/);
    assert.equal(store.all("experiment-round", project.id).length, 1);
    assert.equal(store.get(task.id).experimentRoundId, round.id);
    assert.equal(store.get(independent.id).status, "ready");
    engine.close(); engine = undefined;
    store.close(); store = new Store(path);
    engine = new Engine(store, runtime, dir);
    await assert.rejects(engine.resolve(gate.id, "Retry after restart", true), /judge authorization/);
    await engine.judge(store.get(project.id), store.get(gate.id));
    assert.equal(store.get(gate.id).status, "resolved", store.get(gate.id).judgeError);
    const successor = store.get(store.get(round.id).nextRoundId, "experiment-round");
    assert.equal(successor.previousRoundId, round.id);
    assert.equal(store.get(gate.id).status, "resolved");
    assert.equal(store.get(task.id).status, "ready");
    assert.equal(store.get(task.id).experimentRoundId, successor.id);
    assert.equal(store.get(task.id).attempt, 0);
    assert.equal(store.get(task.id).judgeRetries, 0);
    assert.equal(store.get(round.id).candidateIds.length, 3);
    assert.equal(store.get(independent.id).status, "ready");
    assert.equal(store.all("approval", project.id).length, 0);
    await engine.run(store.get(project.id), "implementation", "successor candidate",
      z.object({}), task, true);
    assert.equal(store.get(successor.id).candidateIds.length, 1);
    assert.equal(store.get(store.get(successor.id).candidateIds[0]).status, "reserved");
    assert.equal(store.get(round.id).candidateIds.length, 3);
    await assert.rejects(engine.resolve(gate.id, "Duplicate", true), /already resolved/);
    store.close(); store = new Store(path);
    assert.equal(store.get(gate.id).status, "resolved");
    assert.equal(store.all("experiment-round", project.id).length, 2);
  } finally {
    engine?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("exhausted experiment gate leaves independent dispatch available and grants no PR approval", async () => {
  const dir = await testFixture("looproom-experiment-frontier-");
  const store = new Store(join(dir, "db"));
  const runtime = Object.assign(new EventEmitter(), { close() {} }) as Runtime;
  const engine = new Engine(store, runtime, dir);
  try {
    store.put("settings", { concurrency: 2 }, "settings");
    const project = store.put("project", { status: "running", planned: true, escalationMode: "human" });
    const blocked = store.put("task", { projectId: project.id, status: "blocked", dependencies: [], title: "Experiment" });
    const independent = store.put("task", { projectId: project.id, status: "ready", dependencies: [], title: "Independent" });
    const round = startExperiment(store, project.id, blocked.id, "Test", contract);
    const gate = engine.gate(project.id, "Experiment round exhausted", "Three candidates discarded", "experiment",
      blocked.id, { experimentRoundId: round.id });
    store.patch(gate.id, { judgeStatus: "answered" });
    const started: string[] = [];
    engine.implement = async (_project, task) => { started.push(task.id); };
    engine.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [independent.id]);
    assert.equal(store.get(blocked.id).status, "blocked");
    assert.equal(store.all("approval", project.id).length, 0);
  } finally {
    engine.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("kept candidate resumes publication without consuming another candidate after restart", async () => {
  const dir = await testFixture("looproom-experiment-publish-");
  const repo = await createRepo(join(dir, "repo"));
  let store = new Store(join(dir, "db"));
  try {
    const project = store.put("project", { path: repo.path, status: "running", github: "", checks: [] });
    const task = store.put("task", { projectId: project.id, status: "ready", worktree: repo.path });
    const baselineRun = store.put("run", { projectId: project.id, taskId: task.id, role: "implementation" });
    const baselineSource = refreshReport(store, project.id, baselineRun.id, [100, 100, 100]);
    store.patch(project.id, { refreshBaseline: { phase: "frozen", evaluatorHash: refreshHash,
      reportId: baselineSource.slice("verification:".length),
      measurementSourceHash: "source-fixed" } });
    const round = startExperiment(store, project.id, task.id, "Measure refresh", refreshContract);
    const run = store.put("run", { projectId: project.id, taskId: task.id, role: "implementation", experimentRoundId: round.id });
    const sourceHash = await sourceFingerprint(repo.path);
    const candidateSource = refreshReport(store, project.id, run.id, [89, 100, 100],
      { checks: true, sourceHash });
    store.patch(task.id, { reviewedSource: { sourceHash,
      tree: await git(repo.path, ["write-tree"]), head: await git(repo.path, ["rev-parse", "HEAD"]), mergeHead: "" } });
    recordCandidate(store, round.id, { runId: run.id, outcome: "keep", measurement: "89 bytes",
      evidence: [candidateSource], ...refreshContract });
    store.close();
    store = new Store(join(dir, "db"));
    const engine = new Engine(store, Object.assign(new EventEmitter(), { close() {} }) as Runtime, dir);
    try {
      let publications = 0;
      engine.publish = async () => { publications++; };
      engine.run = async () => { throw new Error("Kept candidate must not run again"); };
      await engine.implement(store.get(project.id), store.get(task.id));
      assert.equal(publications, 1);
      assert.equal(store.get(round.id).candidateIds.length, 1);
      assert.equal(store.all("approval", project.id).length, 0);
    } finally { engine.close(); }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("kept round PR repair runs after restart without another candidate or approval", async () => {
  const dir = await testFixture("looproom-kept-pr-repair-");
  const repo = await createRepo(join(dir, "repo"));
  const db = join(dir, "db");
  let store = new Store(db);
  let engine: Engine | undefined;
  try {
    store.put("settings", { subagent: { model: "fixture", effort: "medium" } }, "settings");
    const project = store.put("project", { path: repo.path, branch: repo.branch, status: "running",
      goal: "Repair PR", constraints: "", checks: ["fixture-check"], github: "fixture/repo" });
    const task = store.put("task", { projectId: project.id, status: "ready", kind: "implementation",
      title: "Repair", description: "", acceptance: [], dependencies: [], attempt: 0 });
    const independent = store.put("task", { projectId: project.id, status: "ready", dependencies: [] });
    const tree = await createWorktree(repo.path, dir, task.id);
    const head = await git(tree.path, ["rev-parse", "HEAD"]);
    const pr = "https://github.com/fixture/repo/pull/9";
    const priorGate = store.put("gate", { projectId: project.id, taskId: task.id,
      type: "pr", status: "superseded", pr, sha: head });
    store.patch(task.id, { worktree: tree.path, branch: tree.branch, baseSha: head,
      pr, sha: head, prRepair: { gateId: priorGate.id, pr, expectedHead: head,
        base: repo.branch, baseSha: head, stage: "prepared" } });
    const baselineOwner = store.put("task", { projectId: project.id, status: "completed",
      kind: "implementation", title: "Baseline owner" });
    const baselineRun = store.put("run", { projectId: project.id, taskId: baselineOwner.id,
      role: "implementation" });
    const baselineSource = refreshReport(store, project.id, baselineRun.id, [100, 100, 100]);
    const baselineReportId = baselineSource.slice("verification:".length);
    await mkdir(join(dir, "verification"), { recursive: true });
    await writeFile(join(dir, "verification", `${baselineReportId}.json`),
      JSON.stringify(store.get(`verification-report:${baselineReportId}`).report));
    store.patch(project.id, { refreshBaseline: { phase: "frozen", evaluatorHash: refreshHash,
      reportId: baselineReportId, measurementSourceHash: "source-fixed",
      ownerTaskId: baselineOwner.id } });
    const round = startExperiment(store, project.id, task.id, "Reduce refresh bytes", refreshContract);
    const keptRun = store.put("run", { projectId: project.id, taskId: task.id,
      role: "implementation", experimentRoundId: round.id, status: "completed" });
    const sourceHash = await sourceFingerprint(tree.path);
    const evidence = refreshReport(store, project.id, keptRun.id, [89, 100, 100],
      { checks: true, sourceHash });
    store.patch(task.id, { reviewedSource: { sourceHash, tree: await git(tree.path, ["write-tree"]),
      head, mergeHead: "" } });
    const candidate = recordCandidate(store, round.id, { runId: keptRun.id, outcome: "keep",
      measurement: "89 bytes", evidence: [evidence], ...refreshContract });
    assert.equal(candidate.outcome, "keep");
    store.close();
    store = new Store(db);
    const turns: string[] = [];
    const runtime = Object.assign(new EventEmitter(), { close() {}, async run(options: any) {
      if (options.prompt.includes("Independently inspect")) {
        turns.push("review");
        return JSON.stringify({ verdict: "pass", summary: "Independent review passed", sources: ["review:repair"] });
      }
      turns.push("repair");
      await writeFile(join(options.cwd, "repair.txt"), "repaired source");
      return JSON.stringify({ summary: "PR repaired", sources: ["source:repair"], humanQuestion: "" });
    } }) as unknown as Runtime;
    engine = new Engine(store, runtime, dir);
    engine.publicationPrInfo = async () => ({ gate: store.get(priorGate.id),
      info: { state: "OPEN", headRefOid: head, url: pr, baseRefName: repo.branch } }) as any;
    engine.verificationRunner = async ({ commands }: any) => ({ id: randomUUID(),
      sourceHash: await sourceFingerprint(tree.path), sourceUnchanged: true,
      results: commands.map((command: string) => ({ command, code: 0 })) }) as any;
    const revisedHead = "b".repeat(40);
    engine.publish = async (_project, current) => {
      const reviewed = store.get(current.id).reviewedSource;
      assert.ok(reviewed?.sourceHash);
      store.patch(current.id, { status: "awaiting_human", sha: revisedHead, prRepair: null });
      store.put("gate", { projectId: project.id, taskId: task.id, type: "pr",
        status: "open", pr, sha: revisedHead, prRunId: store.get(task.id).implementationRunId });
    };
    await assert.rejects(engine.run(store.get(project.id), "implementation", "closed round",
      z.object({}), store.get(task.id), true), /Experiment round is not active/);
    assert.equal(store.all("run", project.id).filter((run) => run.taskId === task.id).length, 1);
    await engine.implement(store.get(project.id), store.get(task.id));
    assert.deepEqual(turns, ["repair", "review"]);
    assert.equal(store.get(round.id).candidateIds.length, 1);
    assert.deepEqual(store.get(candidate.id).evidence, [evidence]);
    assert.equal(store.get(candidate.id).measurement, "89 bytes");
    assert.equal(store.get(candidate.id).outcome, "keep");
    const repairRun = store.get(store.get(task.id).implementationRunId);
    assert.equal(repairRun.status, "completed");
    assert.equal(repairRun.experimentRoundId, round.id);
    assert.equal(repairRun.experimentCandidateId, undefined);
    assert.equal(store.get(task.id).checks[0].code, 0);
    const reviews = store.all("run", project.id).filter((run) => run.taskId === task.id && run.role === "review");
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].status, "completed");
    const freshGates = store.all("gate", project.id).filter((gate) => gate.type === "pr" && gate.status === "open");
    assert.equal(freshGates.length, 1);
    assert.equal(freshGates[0].sha, revisedHead);
    assert.notEqual(freshGates[0].sha, priorGate.sha);
    assert.equal(store.get(independent.id).status, "ready");
    assert.equal(store.all("approval", project.id).length, 0);
  } finally { engine?.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const remaining of [false, true]) {
  test(`merged kept PR ${remaining ? "rechecks unpublished files" : "settles clean head"} after restart`, async () => {
    const dir = await testFixture("looproom-kept-merged-followup-");
    const repo = await createRepo(join(dir, "repo"));
    const origin = join(dir, "origin.git");
    await git(repo.path, ["clone", "--bare", repo.path, origin]);
    await git(repo.path, ["remote", "add", "origin", origin]);
    const db = join(dir, "db");
    let store = new Store(db);
    let engine: Engine | undefined;
    try {
      store.put("settings", { subagent: { model: "fixture", effort: "medium" } }, "settings");
      const project = store.put("project", { path: repo.path, branch: repo.branch, status: "paused",
        goal: "Preserve kept work", constraints: "", checks: ["fixture-check"], github: "fixture/repo" });
      const task = store.put("task", { projectId: project.id, status: "ready", kind: "implementation",
        title: "Repair", description: "", acceptance: [], dependencies: [], attempt: 0 });
      const independent = store.put("task", { projectId: project.id, status: "ready", dependencies: [] });
      const tree = await createWorktree(repo.path, dir, task.id);
      await writeFile(join(tree.path, "feature.txt"), "kept feature\n");
      await git(tree.path, ["add", "feature.txt"]);
      await git(tree.path, ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "Kept feature"]);
      const head = await git(tree.path, ["rev-parse", "HEAD"]);
      await git(repo.path, ["merge", "--ff-only", head]);
      await git(repo.path, ["push", "origin", repo.branch]);
      const pr = "https://github.com/fixture/repo/pull/9";
      const gate = store.put("gate", { projectId: project.id, taskId: task.id,
        type: "pr", status: "superseded", pr, sha: head });
      store.patch(task.id, { worktree: tree.path, branch: tree.branch, baseSha: head,
        pr, sha: head, prRepair: { gateId: gate.id, pr, expectedHead: head,
          base: repo.branch, baseSha: head, stage: "prepared" } });
      const baselineOwner = store.put("task", { projectId: project.id, status: "completed", kind: "implementation" });
      const baselineRun = store.put("run", { projectId: project.id, taskId: baselineOwner.id,
        role: "implementation" });
      const baselineSource = refreshReport(store, project.id, baselineRun.id, [100, 100, 100]);
      const baselineReportId = baselineSource.slice("verification:".length);
      await mkdir(join(dir, "verification"), { recursive: true });
      await writeFile(join(dir, "verification", `${baselineReportId}.json`),
        JSON.stringify(store.get(`verification-report:${baselineReportId}`).report));
      store.patch(project.id, { refreshBaseline: { phase: "frozen", evaluatorHash: refreshHash,
        reportId: baselineReportId, measurementSourceHash: "source-fixed", ownerTaskId: baselineOwner.id } });
      const round = startExperiment(store, project.id, task.id, "Reduce refresh bytes", refreshContract);
      const keptRun = store.put("run", { projectId: project.id, taskId: task.id, role: "implementation",
        experimentRoundId: round.id, status: "completed" });
      const sourceHash = await sourceFingerprint(tree.path);
      const evidence = refreshReport(store, project.id, keptRun.id, [89, 100, 100],
        { checks: true, sourceHash });
      store.patch(task.id, { reviewedSource: { sourceHash, tree: await git(tree.path, ["write-tree"]),
        head, mergeHead: "" } });
      const candidate = recordCandidate(store, round.id, { runId: keptRun.id, outcome: "keep",
        measurement: "89 bytes", evidence: [evidence], ...refreshContract });
      assert.equal(candidate.outcome, "keep");
      if (remaining) await writeFile(join(tree.path, "remaining.txt"), "unpublished repair\n");
      const mergedInfo = { number: 9, url: pr, baseRefName: repo.branch, headRefOid: head,
        state: "MERGED", mergedAt: new Date().toISOString(), mergeCommit: { oid: head } };
      engine = new Engine(store, Object.assign(new EventEmitter(), { close() {} }) as Runtime, dir);
      engine.gitRunner = git;
      await engine.settleMergedRepair(store.get(project.id), store.get(task.id), store.get(gate.id), mergedInfo);
      assert.equal(store.get(gate.id).status, "reconciled");
      assert.equal(store.get(task.id).status, remaining ? "ready" : "completed");
      engine.close(); engine = undefined; store.close();
      store = new Store(db);
      const turns: string[] = [];
      const runtime = Object.assign(new EventEmitter(), { close() {}, async run(options: any) {
        if (options.prompt.includes("Independently inspect")) {
          turns.push("review");
          return JSON.stringify({ verdict: "pass", summary: "Remaining work reviewed", sources: ["source:review"] });
        }
        turns.push("followup");
        return JSON.stringify({ summary: "Remaining work", sources: ["source:remaining"], humanQuestion: "" });
      } }) as unknown as Runtime;
      engine = new Engine(store, runtime, dir);
      engine.gitRunner = git;
      engine.githubRunner = async args => { assert.equal(args[0], "auth"); return "fixture"; };
      engine.createPrOrReuse = async () => "https://github.com/fixture/repo/pull/10";
      engine.verificationRunner = async ({ commands }: any) => ({ id: randomUUID(),
        sourceHash: await sourceFingerprint(tree.path), sourceUnchanged: true,
        results: commands.map((command: string) => ({ command, code: 0 })) }) as any;
      store.patch(project.id, { status: "running" });
      const beforeRun = store.all("run", project.id).length;
      await assert.rejects(engine.run(store.get(project.id), "implementation", "closed round",
        z.object({}), store.get(task.id), true), /Experiment round is not active/);
      assert.equal(store.all("run", project.id).length, beforeRun);
      assert.deepEqual(turns, []);
      if (remaining) {
        await engine.implement(store.get(project.id), store.get(task.id));
        assert.deepEqual(turns, ["followup", "review"]);
        const followupRun = store.get(store.get(task.id).implementationRunId);
        assert.equal(followupRun.experimentRoundId, round.id);
        assert.equal(followupRun.experimentCandidateId, undefined);
        assert.equal(store.get(task.id).checks[0].code, 0);
        assert.equal(store.all("run", project.id).filter(run => run.taskId === task.id && run.role === "review").length, 1);
        const newGate = store.all("gate", project.id).find(g => g.type === "pr" && g.status === "open");
        assert.ok(newGate);
        assert.notEqual(newGate.sha, gate.sha);
        assert.equal(newGate.pr, "https://github.com/fixture/repo/pull/10");
      } else {
        assert.equal(store.get(task.id).status, "completed");
        assert.deepEqual(turns, []);
      }
      const runCount = store.all("run", project.id).filter(run => run.taskId === task.id).length;
      await engine.implement(store.get(project.id), store.get(task.id));
      assert.equal(store.all("run", project.id).filter(run => run.taskId === task.id).length, runCount);
      assert.equal(store.get(round.id).candidateIds.length, 1);
      assert.equal(store.get(candidate.id).outcome, "keep");
      assert.equal(store.get(candidate.id).measurement, "89 bytes");
      assert.deepEqual(store.get(candidate.id).evidence, [evidence]);
      assert.equal(store.get(independent.id).status, "ready");
      assert.equal(store.all("approval", project.id).length, 0);
    } finally { engine?.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test("discarded files are cleared before the next candidate without changing its round", async () => {
  const dir = await testFixture("looproom-experiment-discard-files-");
  const repo = await createRepo(join(dir, "repo"));
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, Object.assign(new EventEmitter(), { close() {} }) as Runtime, dir);
  try {
    const project = store.put("project", { path: repo.path, status: "running", checks: [], goal: "Improve refresh", constraints: "" });
    const task = store.put("task", { projectId: project.id, status: "ready", kind: "implementation",
      title: "Try candidates", description: "Measure", acceptance: [], dependencies: [], attempt: 0 });
    const tree = await createWorktree(repo.path, dir, task.id);
    store.patch(task.id, { worktree: tree.path });
    const round = startExperiment(store, project.id, task.id, "Reduce latency", contract);
    const firstRun = store.put("run", { projectId: project.id, taskId: task.id, role: "implementation", experimentRoundId: round.id });
    recordCandidate(store, round.id, { runId: firstRun.id, outcome: "discard", measurement: "120 ms",
      evidence: ["report:1"], evaluator: contract.evaluator, workload: contract.workload,
      runtimeBudget: contract.runtimeBudget, thresholds: contract.thresholds });
    await writeFile(join(tree.path, "discarded.txt"), "failed candidate");
    await git(tree.path, ["add", "discarded.txt"]);
    engine.run = async (_project, _role, prompt) => {
      await assert.rejects(access(join(tree.path, "discarded.txt")));
      assert.match(prompt, /Experiment round 1/);
      const run = store.put("run", { projectId: project.id, taskId: task.id, role: "implementation", experimentRoundId: round.id });
      store.patch(task.id, { implementationRunId: run.id });
      const slot = reserveCandidate(store, round.id, run.id);
      store.patch(run.id, { experimentCandidateId: slot.id });
      await writeFile(join(tree.path, "second.txt"), "failed again");
      const result = { summary: "Second candidate discarded", sources: ["report:2"], humanQuestion: "",
        experimentCandidate: { outcome: "discard", measurement: "110 ms", evidence: ["report:2"],
          evaluator: contract.evaluator, workload: contract.workload, runtimeBudget: contract.runtimeBudget,
          thresholds: contract.thresholds } } as any;
      reportCandidate(store, slot.id, result.experimentCandidate);
      return result;
    };
    await engine.implement(store.get(project.id), store.get(task.id));
    assert.equal(store.get(round.id).candidateIds.length, 2);
    assert.equal(store.get(task.id).status, "ready");
    assert.equal(store.get(task.id).experimentRoundId, round.id);
    assert.equal(store.all("approval", project.id).length, 0);
  } finally { engine.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const finalSlot of [false, true]) {
  test(`failed worker settles ${finalSlot ? "final" : "nonfinal"} experiment slot across restart`, async () => {
    const dir = await testFixture(`looproom-failed-worker-${finalSlot}-`);
    const repo = await createRepo(join(dir, "repo"));
    const db = join(dir, "db");
    let store = new Store(db);
    let engine: Engine | undefined;
    try {
      store.put("settings", { subagent: { model: "fixture", effort: "medium" } }, "settings");
      const project = store.put("project", { path: repo.path, branch: repo.branch,
        status: "running", goal: "Measure", constraints: "", checks: [], escalationMode: "yolo" });
      const task = store.put("task", { projectId: project.id, status: "ready", kind: "implementation",
        title: "Candidate", description: "", acceptance: [], dependencies: [], attempt: 0 });
      const independent = store.put("task", { projectId: project.id, status: "ready", dependencies: [] });
      const tree = await createWorktree(repo.path, dir, task.id);
      store.patch(task.id, { worktree: tree.path });
      const round = startExperiment(store, project.id, task.id, "Reduce latency", contract);
      if (finalSlot) for (let i = 0; i < 2; i++) {
        const run = store.put("run", { projectId: project.id, taskId: task.id,
          role: "implementation", experimentRoundId: round.id });
        recordCandidate(store, round.id, { runId: run.id, outcome: "discard",
          measurement: `${120 - i} ms`, evidence: [`report:${i}`], ...contract });
      }
      const separate = finalSlot ? store.put("gate", { projectId: project.id, taskId: task.id,
        type: "decision", status: "open", detail: "Separate consequential choice" }) : undefined;
      const runtime = Object.assign(new EventEmitter(), { close() {}, async run() {
        const run = store.get(store.get(task.id).implementationRunId);
        if (finalSlot) reportCandidate(store, run.experimentCandidateId, {
          outcome: "keep", measurement: "90 ms", evidence: ["report:failed-run"], ...contract });
        throw new Error("worker process failed");
      } }) as unknown as Runtime;
      engine = new Engine(store, runtime, dir);
      await engine.implement(store.get(project.id), store.get(task.id));
      const failedRun = store.get(store.get(task.id).implementationRunId);
      const candidate = store.get(failedRun.experimentCandidateId);
      assert.equal(failedRun.status, "failed");
      assert.match(failedRun.error, /worker process failed/);
      assert.equal(candidate.status, finalSlot ? "finalized" : "unmeasured");
      if (finalSlot) {
        assert.equal(candidate.outcome, "discard");
        assert.deepEqual(candidate.evidence, ["report:failed-run"]);
      }
      engine.close(); engine = undefined;
      store.close(); store = new Store(db);
      assert.equal(store.get(candidate.id).status, candidate.status);
      if (separate) assert.equal(store.get(separate.id).status, "open");
      assert.equal(store.get(independent.id).status, "ready");
      assert.equal(store.get(task.id).status, finalSlot ? "blocked" : "ready");
      const experimentGates = store.all("gate", project.id).filter(g => g.type === "experiment" && g.status === "open");
      assert.equal(experimentGates.length, finalSlot ? 1 : 0);
      assert.equal(store.get(round.id).status, finalSlot ? "exhausted" : "active");
      assert.equal(store.all("gate", project.id).filter(g => g.type === "runtime").length, 0);
      assert.equal(store.all("approval", project.id).length, 0);
      if (!finalSlot) {
        const next = store.put("run", { projectId: project.id, taskId: task.id,
          role: "implementation", experimentRoundId: round.id });
        assert.equal(reserveCandidate(store, round.id, next.id).number, 2);
      }
    } finally { engine?.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const failureStage of ["staging", "review"] as const) {
  for (const finalSlot of [false, true]) {
    test(`${failureStage} throw after report discards ${finalSlot ? "final" : "available"} slot across restart`, async () => {
      const dir = await testFixture(`looproom-post-report-${failureStage}-${finalSlot}-`);
      const repo = await createRepo(join(dir, "repo"));
      const db = join(dir, "db");
      let store = new Store(db);
      let engine: Engine | undefined;
      try {
        store.put("settings", { subagent: { model: "fixture", effort: "medium" } }, "settings");
        const project = store.put("project", { path: repo.path, branch: repo.branch,
          status: "running", goal: "Measure", constraints: "",
          checks: ["fixture-check"], escalationMode: "yolo" });
        const task = store.put("task", { projectId: project.id, status: "ready",
          kind: "implementation", title: "Candidate", description: "", acceptance: [],
          dependencies: [], attempt: 0 });
        const independent = store.put("task", { projectId: project.id,
          status: "ready", dependencies: [] });
        const tree = await createWorktree(repo.path, dir, task.id);
        store.patch(task.id, { worktree: tree.path });
        const round = startExperiment(store, project.id, task.id, "Reduce latency", refreshContract);
        if (finalSlot) for (let i = 0; i < 2; i++) {
          const prior = store.put("run", { projectId: project.id, taskId: task.id,
            role: "implementation", experimentRoundId: round.id, status: "completed" });
          recordCandidate(store, round.id, { runId: prior.id, outcome: "discard",
            measurement: `${120 - i} ms`, evidence: [`report:${i}`], ...refreshContract });
        }
        const separate = finalSlot ? store.put("gate", { projectId: project.id,
          taskId: task.id, type: "decision", status: "open",
          detail: "Separate consequential choice" }) : undefined;
        const runtime = Object.assign(new EventEmitter(), { close() {}, async run(options: any) {
          if (options.prompt.includes("Independently inspect")) {
            throw new Error("review transport failed");
          }
          await writeFile(join(options.cwd, "candidate.txt"), "measured source");
          return JSON.stringify({ summary: "Measured candidate", sources: ["report:measured"],
            humanQuestion: "", experimentCandidate: { outcome: "keep", measurement: "90 ms",
              evidence: ["report:measured"], ...refreshContract } });
        } }) as unknown as Runtime;
        engine = new Engine(store, runtime, dir);
        if (failureStage === "staging")
          engine.stageProduct = async () => { throw new Error("staging failed"); };
        else engine.verify = async () => ({ id: "check-post-report",
          sourceHash: await sourceFingerprint(tree.path), sourceUnchanged: true,
          results: [{ command: "fixture-check", code: 0 }] }) as any;
        await engine.implement(store.get(project.id), store.get(task.id));
        const candidateId = store.get(round.id).candidateIds.at(-1)!;
        const candidate = store.get(candidateId);
        const run = store.get(candidate.runId);
        assert.equal(run.status, "completed");
        assert.equal(candidate.status, "finalized");
        assert.equal(candidate.outcome, "discard");
        assert.equal(candidate.reportedOutcome, "keep");
        assert.equal(candidate.measurement, "90 ms");
        assert.ok(candidate.evidence.includes("report:measured"));
        assert.match(candidate.rejection, new RegExp(failureStage));
        assert.match(candidate.rejection, failureStage === "staging"
          ? /staging failed/ : /review transport failed/);
        if (failureStage === "review") {
          const failedReview = store.all("run", project.id).find((item) =>
            item.taskId === task.id && item.role === "review");
          assert.equal(failedReview?.status, "failed");
          assert.match(failedReview!.error, /review transport failed/);
          assert.ok(candidate.evidence.includes(`review-run:${failedReview!.id}`));
        }
        engine.close(); engine = undefined;
        store.close(); store = new Store(db);
        assert.equal(store.get(candidateId).outcome, "discard");
        assert.equal(store.get(candidateId).measurement, "90 ms");
        assert.equal(store.get(round.id).candidateIds.length, finalSlot ? 3 : 1);
        if (separate) assert.equal(store.get(separate.id).status, "open");
        assert.equal(store.get(round.id).status, finalSlot ? "exhausted" : "active");
        assert.equal(store.get(task.id).status, finalSlot ? "blocked" : "ready");
        assert.equal(store.get(independent.id).status, "ready");
        assert.equal(store.all("gate", project.id).filter((gate) =>
          gate.type === "experiment" && gate.status === "open").length, finalSlot ? 1 : 0);
        assert.equal(store.all("gate", project.id).filter((gate) => gate.type === "runtime").length, 0);
        assert.equal(store.all("approval", project.id).length, 0);
      } finally { engine?.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
    });
  }
}

for (const failure of ["check", "review"] as const) {
  test(`${failure} failure discards measured candidates across restart and exhausts only their task`, async () => {
    const dir = await testFixture(`looproom-experiment-${failure}-recovery-`);
    const repo = await createRepo(join(dir, "repo"));
    const path = join(dir, "db");
    let store = new Store(path);
    let engine: Engine | undefined;
    try {
      store.put("settings", { subagent: { model: "fixture", effort: "medium" } }, "settings");
      const project = store.put("project", { path: repo.path, branch: repo.branch, status: "running",
        goal: "Measure refresh", constraints: "", checks: ["fixture-check"], escalationMode: "yolo" });
      const task = store.put("task", { projectId: project.id, status: "ready", kind: "implementation",
        title: "Measure candidate", description: "", acceptance: [], dependencies: [], attempt: 0 });
      const independent = store.put("task", { projectId: project.id, status: "ready", dependencies: [] });
      const tree = await createWorktree(repo.path, dir, task.id);
      store.patch(task.id, { worktree: tree.path });
      const round = startExperiment(store, project.id, task.id, "Reduce latency", contract);
      let attempt = 0;
      const attach = () => {
        engine = new Engine(store, Object.assign(new EventEmitter(), { close() {} }) as Runtime, dir);
        engine.run = async (_project, role) => {
          if (role === "implementation") {
            attempt++;
            const run = store.put("run", { projectId: project.id, taskId: task.id, role,
              experimentRoundId: role === "implementation" ? round.id : undefined });
            store.patch(task.id, { implementationRunId: run.id });
            const slot = reserveCandidate(store, round.id, run.id);
            store.patch(run.id, { experimentCandidateId: slot.id });
            await writeFile(join(tree.path, "candidate.txt"), `candidate ${attempt}`);
            const result = { summary: `Measured candidate ${attempt}`, sources: [], humanQuestion: "",
              experimentCandidate: { outcome: "keep", measurement: `${120 - attempt} ms`,
                evidence: [`measurement:${attempt}`], evaluator: contract.evaluator,
                workload: contract.workload, runtimeBudget: contract.runtimeBudget,
                thresholds: contract.thresholds } } as any;
            reportCandidate(store, slot.id, result.experimentCandidate);
            return result;
          }
          store.put("run", { projectId: project.id, taskId: task.id, role });
          return { verdict: "changes", summary: `Review rejected candidate ${attempt}`,
            sources: [`review:${attempt}`] } as any;
        };
        engine.verificationRunner = async ({ cwd }) => ({ id: `check-${attempt}`,
          sourceHash: await sourceFingerprint(cwd), sourceUnchanged: true, reportPath: `check-${attempt}.json`,
          createdAt: new Date().toISOString(),
          results: [{ command: "fixture-check", code: failure === "check" ? 1 : 0,
            output: failure === "check" ? "check rejected candidate" : "passed",
            timedOut: false, durationMs: 1 }] });
      };
      attach();
      for (let i = 1; i <= 3; i++) {
        await engine!.implement(store.get(project.id), store.get(task.id));
        const candidate = store.get(store.get(round.id).candidateIds[i - 1], "experiment-candidate");
        assert.equal(candidate.outcome, "discard");
        assert.equal(candidate.reportedOutcome, "keep");
        assert.equal(candidate.measurement, `${120 - i} ms`);
        assert.ok(candidate.evidence.includes(`measurement:${i}`));
        assert.ok(candidate.evidence.includes(failure === "check" ? `verification:check-${i}` : `review:${i}`));
        const run = store.get(candidate.runId);
        assert.equal(run.checkEvidence.reportId, `check-${i}`);
        assert.equal(store.get(independent.id).status, "ready");
        if (i === 1) {
          engine!.close(); engine = undefined;
          store.close(); store = new Store(path);
          const persisted = store.get(store.get(round.id).candidateIds[0], "experiment-candidate");
          assert.equal(persisted.outcome, "discard");
          assert.equal(persisted.reportedOutcome, "keep");
          assert.equal(store.get(persisted.runId).checkEvidence.reportId, "check-1");
          attach();
        }
      }
      assert.equal(store.get(round.id).status, "exhausted");
      assert.equal(store.get(task.id).status, "blocked");
      assert.equal(store.all("gate", project.id).filter((gate) => gate.type === "experiment" && gate.status === "open").length, 1);
      assert.equal(store.all("gate", project.id).filter((gate) => gate.type === "check" || gate.type === "review").length, 0);
      assert.equal(store.get(independent.id).status, "ready");
      assert.equal(store.all("approval", project.id).length, 0);
      const fourth = store.put("run", { projectId: project.id, taskId: task.id, role: "implementation", experimentRoundId: round.id });
      assert.throws(() => recordCandidate(store, round.id, { runId: fourth.id, outcome: "discard",
        measurement: "90 ms", evidence: ["measurement:4"], evaluator: contract.evaluator,
        workload: contract.workload, runtimeBudget: contract.runtimeBudget, thresholds: contract.thresholds }),
      /active experiment round/);
    } finally { engine?.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const exit of ["question", "missing-checks", "review-decision"] as const) {
  for (const priorCount of [1, 2]) test(`${exit} finalizes its measured slot after ${priorCount} prior candidates and preserves one gate across restart`, async () => {
    const dir = await testFixture(`looproom-experiment-${exit}-slot-`);
    const repo = await createRepo(join(dir, "repo"));
    const path = join(dir, "db");
    let store = new Store(path);
    let engine: Engine | undefined;
    try {
      const project = store.put("project", { path: repo.path, branch: repo.branch,
        status: "running", goal: "Measure refresh", constraints: "",
        checks: exit === "review-decision" ? ["fixture-check"] : [] });
      const task = store.put("task", { projectId: project.id, status: "ready",
        kind: "implementation", title: "Measure candidate", description: "", acceptance: [],
        dependencies: [], attempt: 0 });
      const independent = store.put("task", { projectId: project.id, status: "ready", dependencies: [] });
      const tree = await createWorktree(repo.path, dir, task.id);
      store.patch(task.id, { worktree: tree.path });
      const round = startExperiment(store, project.id, task.id, "Reduce latency", contract);
      const priors = Array.from({ length: priorCount }, (_, index) => {
        const priorRun = store.put("run", { projectId: project.id, taskId: task.id,
          role: "implementation", experimentRoundId: round.id });
        return recordCandidate(store, round.id, { runId: priorRun.id, outcome: "discard",
          measurement: `${130 - index} ms`, evidence: [`measurement:prior:${index}`], ...contract });
      });
      engine = new Engine(store, Object.assign(new EventEmitter(), { close() {} }) as Runtime, dir);
      engine.run = async (_project, role) => {
        if (role === "review") return { verdict: "gate", summary: "Review decision needed",
          sources: ["review:evidence"] } as any;
        const run = store.put("run", { projectId: project.id, taskId: task.id,
          role: "implementation", experimentRoundId: round.id, status: "completed" });
        const slot = reserveCandidate(store, round.id, run.id);
        store.patch(run.id, { experimentCandidateId: slot.id });
        store.patch(task.id, { implementationRunId: run.id });
        const reported = { outcome: "keep" as const, measurement: "90 ms",
          evidence: ["measurement:current"], ...contract };
        reportCandidate(store, slot.id, reported);
        return { summary: "Measured candidate", sources: ["measurement:current"],
          humanQuestion: exit === "question" ? "Choose a dependency" : "",
          experimentCandidate: reported } as any;
      };
      engine.verificationRunner = async ({ cwd }) => ({ id: "check-slot", sourceHash: await sourceFingerprint(cwd),
        sourceUnchanged: true, reportPath: "check-slot.json", createdAt: new Date().toISOString(),
        results: [{ command: "fixture-check", code: 0, output: "passed", timedOut: false, durationMs: 1 }] });
      await engine.implement(store.get(project.id), store.get(task.id));
      const candidate = store.get(store.get(round.id).candidateIds[priorCount]);
      assert.equal(candidate.status, "finalized");
      assert.equal(candidate.outcome, "discard");
      assert.equal(candidate.reportedOutcome, "keep");
      assert.equal(candidate.measurement, "90 ms");
      assert.ok(candidate.evidence.includes("measurement:current"));
      if (exit === "review-decision") assert.ok(candidate.evidence.includes("review:evidence"));
      assert.throws(() => finalizeCandidate(store, candidate.id, "keep"), /not pending/);
      assert.ok(priors.every((prior) => store.get(prior.id).outcome === "discard"));
      engine.close(); engine = undefined;
      store.close(); store = new Store(path);
      assert.equal(store.get(candidate.id).outcome, "discard");
      assert.equal(store.get(candidate.id).runId, candidate.runId);
      assert.equal(store.get(round.id).candidateIds.length, priorCount + 1);
      const open = store.all("gate", project.id).filter((gate) => gate.status === "open" && gate.taskId === task.id);
      assert.equal(open.length, 1);
      if (priorCount === 2) {
        assert.equal(open[0].type, "experiment");
        assert.match(open[0].detail, exit === "question" ? /Choose a dependency/ :
          exit === "review-decision" ? /Review decision needed/ : /Acceptance checks missing/);
        assert.equal(store.get(round.id).status, "exhausted");
      } else {
        assert.notEqual(open[0].type, "experiment");
      }
      if (priorCount === 1) {
      const lastRun = store.put("run", { projectId: project.id, taskId: task.id,
        role: "implementation", experimentRoundId: round.id });
      const last = reserveCandidate(store, round.id, lastRun.id);
      reportCandidate(store, last.id, { outcome: "discard", measurement: "95 ms",
        evidence: ["measurement:last"], ...contract });
      finalizeCandidate(store, last.id, "discard");
      assert.equal(store.get(round.id).status, "exhausted");
      }
      const fourth = store.put("run", { projectId: project.id, taskId: task.id,
        role: "implementation", experimentRoundId: round.id });
      assert.throws(() => reserveCandidate(store, round.id, fourth.id), /active experiment round/);
      assert.equal(store.get(independent.id).status, "ready");
      assert.equal(store.all("approval", project.id).length, 0);
    } finally { engine?.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test("interrupted reserved run is gated after restart without duplicate dispatch", async () => {
  const dir = await testFixture("looproom-experiment-pending-slot-");
  const repo = await createRepo(join(dir, "repo"));
  const path = join(dir, "db");
  let store = new Store(path);
  try {
    const project = store.put("project", { path: repo.path, status: "running", goal: "Measure",
      constraints: "", checks: [] });
    const task = store.put("task", { projectId: project.id, status: "ready", kind: "implementation",
      title: "Candidate", dependencies: [], attempt: 0 });
    const independent = store.put("task", { projectId: project.id, status: "ready", dependencies: [] });
    const round = startExperiment(store, project.id, task.id, "Reduce latency", contract);
    const run = store.put("run", { projectId: project.id, taskId: task.id,
      role: "implementation", experimentRoundId: round.id, status: "running" });
    const slot = reserveCandidate(store, round.id, run.id);
    store.patch(run.id, { experimentCandidateId: slot.id });
    store.close(); store = new Store(path);
    const engine = new Engine(store, Object.assign(new EventEmitter(), { close() {} }) as Runtime, dir);
    try {
      let dispatches = 0;
      engine.run = async () => { dispatches++; throw new Error("duplicate dispatch"); };
      await engine.implement(store.get(project.id), store.get(task.id));
      assert.equal(dispatches, 0);
      assert.equal(store.get(slot.id).status, "unmeasured");
      assert.equal(store.get(slot.id).measurement, undefined);
      assert.equal(store.get(round.id).candidateIds.length, 1);
      assert.equal(store.all("gate", project.id).filter((gate) => gate.type === "interrupted").length, 1);
      assert.equal(store.get(independent.id).status, "ready");
      assert.equal(store.all("approval", project.id).length, 0);
    } finally { engine.close(); }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a fourth implementation run is refused before worker dispatch", async () => {
  const dir = await testFixture("looproom-experiment-fourth-dispatch-");
  const store = new Store(join(dir, "db"));
  try {
    store.put("settings", { subagent: { model: "fixture", effort: "medium" } }, "settings");
    const project = store.put("project", { path: dir, status: "running", goal: "Measure", constraints: "" });
    const task = store.put("task", { projectId: project.id, status: "ready", kind: "implementation" });
    const round = startExperiment(store, project.id, task.id, "Reduce latency", contract);
    assert.equal(task.experimentRoundId, undefined);
    assert.equal(store.get(task.id).experimentRoundId, round.id);
    for (let i = 0; i < 3; i++) {
      const run = store.put("run", { projectId: project.id, taskId: task.id,
        role: "implementation", experimentRoundId: round.id });
      recordCandidate(store, round.id, { runId: run.id, outcome: "discard",
        measurement: `${120 - i} ms`, evidence: [`measurement:${i}`], ...contract });
    }
    let dispatches = 0;
    const runtime = Object.assign(new EventEmitter(), { close() {}, async run() {
      dispatches++; return "{}";
    } }) as unknown as Runtime;
    const engine = new Engine(store, runtime, dir);
    try {
      const before = store.all("run", project.id).length;
      await assert.rejects(engine.run(project, "implementation", "candidate", z.object({}), task, true),
        /Experiment round is not active/);
      assert.equal(dispatches, 0);
      assert.equal(store.all("run", project.id).length, before);
      assert.equal(store.get(round.id).candidateIds.length, 3);
      assert.equal(store.all("approval", project.id).length, 0);
    } finally { engine.close(); }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("completed run without a measurement consumes no measured outcome and opens a gate", async () => {
  const dir = await testFixture("looproom-experiment-unmeasured-");
  const repo = await createRepo(join(dir, "repo"));
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, Object.assign(new EventEmitter(), { close() {} }) as Runtime, dir);
  try {
    const project = store.put("project", { path: repo.path, status: "running", goal: "Measure",
      constraints: "", checks: [] });
    const task = store.put("task", { projectId: project.id, status: "ready", kind: "implementation",
      title: "Candidate", description: "", acceptance: [], dependencies: [], attempt: 0,
      worktree: repo.path });
    const round = startExperiment(store, project.id, task.id, "Reduce latency", contract);
    assert.equal(task.experimentRoundId, undefined);
    assert.equal(store.get(task.id).experimentRoundId, round.id);
    engine.run = async () => {
      const run = store.put("run", { projectId: project.id, taskId: task.id,
        role: "implementation", experimentRoundId: round.id, status: "completed" });
      const slot = reserveCandidate(store, round.id, run.id);
      store.patch(run.id, { experimentCandidateId: slot.id });
      store.patch(task.id, { implementationRunId: run.id });
      return { summary: "No measurement yet", sources: [], humanQuestion: "" } as any;
    };
    await engine.implement(project, task);
    const slot = store.get(store.get(round.id).candidateIds[0]);
    assert.equal(slot.status, "unmeasured");
    assert.equal(slot.measurement, undefined);
    assert.equal(slot.outcome, undefined);
    assert.equal(store.get(task.id).status, "blocked");
    assert.equal(store.all("gate", project.id).filter((gate) => gate.title === "Experiment run has no measurement").length, 1);
    assert.equal(store.all("approval", project.id).length, 0);
  } finally { engine.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
