import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Engine } from "./engine.ts";
import { Store } from "./store.ts";
import { BROWSER_PROTOCOL_HASH, type BrowserAuditReport } from "./browser-audit.ts";
import { sourceFingerprint } from "./verification.ts";
import { captureBrowserSnapshot } from "./browser-snapshot.ts";
import { testFixture } from "./test-fixtures.ts";
import type { Runtime } from "./runtime.ts";

const operations = ["goal.load", "goal.scroll", "goal.latest", "goal.context", "work.open", "work.connections",
  "work.task", "work.navigation", "work.filter", "work.search", "review.open", "review.context",
  "memory.open", "memory.outcome", "memory.search", "memory.clear", "memory.sources"];
const checkpoints = ["Goal conversation", "Latest messages", "Context", "Context return", "Work", "Connections", "Workstream",
  "Inspect task", "Next task", "Previous task", "Filter tasks by state", "Search tasks", "Review",
  "Decision gate", "Memory", "Outcome", "Search project memory", "Sources", "Library"];

async function fixture() {
  const dir = await testFixture("looproom-browser-engine-");
  const worktree = join(dir, "task");
  await mkdir(worktree);
  const store = new Store(join(dir, "looproom.sqlite"));
  store.put("settings", { subagent: { model: "gpt-6-sol", effort: "medium" } }, "settings");
  const runtime = Object.assign(new EventEmitter(), { binary: "codex", close() {} }) as Runtime;
  const engine = new Engine(store, runtime, dir);
  const project = store.put("project", { path: dir, status: "running", escalationMode: "yolo", checks: [] });
  const task = store.put("task", { projectId: project.id, worktree, status: "blocked", acceptance: [] });
  const gate = engine.gate(project.id, "Actual browser baseline", "Need real-record browser measurement", "review", task.id);
  return { dir, worktree, store, engine, project, task, gate, async close() { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

function report(projectId: string, dir: string, complete: boolean): BrowserAuditReport {
  const id = randomUUID();
  const samples: BrowserAuditReport["observations"]["samples"] = [];
  const aggregates: BrowserAuditReport["observations"]["aggregates"] = {};
  if (complete) {
    for (const viewport of ["desktop", "mobile"] as const) {
      for (let repetition = 0; repetition <= 5; repetition++) samples.push({
        viewport, repetition, warmup: repetition === 0,
        operations: operations.map(name => ({ name, durationMs: 100, maxLongTaskMs: 0, focus: "button", focusVisible: true, focusClipped: false, horizontalOverflow: false })),
        navigation: { domContentLoadedMs: 10, transferBytes: 100, resourceBytes: 100, cachedAssetCount: 1 },
        keyboard: checkpoints.map(checkpoint => ({ checkpoint, focused: checkpoint, focusVisible: true, clipped: false, reached: true })),
        errors: [], unavailable: [],
      });
      for (const name of operations) aggregates[`${viewport}.${name}`] = {
        rawMs: [100, 100, 100, 100, 100], p75Ms: 100, medianMs: 100, maximumLongTaskMs: 0,
      };
    }
  }
  const artifacts = complete
    ? [...samples.map(s => join(dir, "browser-audit", id, `${s.viewport}-${s.repetition}.png`)), join(dir, "browser-audit", id, "trace.zip")]
    : [];
  samples.forEach((sample, index) => { sample.screenshot = artifacts[index]; });
  return { id, kind: "browser-baseline", projectId, sourceHash: "source", sourceSha: "a".repeat(40),
    sourceUnchanged: true, buildHash: "c".repeat(64), snapshotId: randomUUID(), snapshotHash: "d".repeat(64),
    protocolHash: BROWSER_PROTOCOL_HASH, evaluatorHash: "b".repeat(64), createdAt: new Date().toISOString(), reportPath: join(dir, "browser-audit", `${id}.json`), measurementDurationMs: complete ? 100 : null,
    status: complete ? "complete" : "unavailable", unavailable: complete ? [] : ["browser unavailable"],
    environment: { reviewGateType: "non-pr", browserVersion: "Chrome fixture", playwrightVersion: "fixture",
      macProductVersion: "26.6", packageLockHash: "e".repeat(64), buildReportId: randomUUID(),
      osVersion: "Darwin fixture", processor: "Apple Silicon", memoryBytes: 16_000_000_000, deviceScaleFactor: 1 },
    observations: { samples, aggregates }, artifacts, artifactHashes: Object.fromEntries(artifacts.map(path => [path, "f".repeat(64)])) };
}

async function persist(f: Awaited<ReturnType<typeof fixture>>, value: BrowserAuditReport) {
  value.sourceHash = await sourceFingerprint(f.worktree);
  const snapshot = await captureBrowserSnapshot({ databasePath: join(f.dir, "looproom.sqlite"),
    projectId: f.project.id, directory: join(f.dir, "browser-snapshots") });
  value.snapshotId = snapshot.id;
  value.snapshotHash = snapshot.hash;
  await persistArtifacts(value);
  await mkdir(join(f.dir, "browser-audit"), { recursive: true });
  await writeFile(value.reportPath, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  return value;
}

async function persistArtifacts(value: BrowserAuditReport) {
  for (const artifact of value.artifacts) {
    await mkdir(dirname(artifact), { recursive: true });
    const bytes = Buffer.from(`synthetic fixture for ${artifact}`);
    await writeFile(artifact, bytes, { flag: "wx" });
    value.artifactHashes[artifact] = createHash("sha256").update(bytes).digest("hex");
  }
}

function mockJudge(f: Awaited<ReturnType<typeof fixture>>) {
  const prompts: string[] = [];
  f.engine.run = async (_project, role, prompt) => {
    assert.equal(role, "judge");
    prompts.push(prompt);
    f.store.put("run", { projectId: f.project.id, taskId: f.task.id, role: "judge" });
    return prompts.length === 1
      ? { action: "wait", answer: "Request real browser measurement", summary: "Need browser", sources: [], verificationRequests: ["browser-baseline"] }
      : { action: "retry", answer: "Use measured report", summary: "Report reviewed", sources: [], verificationRequests: [] };
  };
  f.engine.recoverEscalation = async (_project, _gate, _task, assessment) => assessment;
  return prompts;
}

test("judge browser request gives worker and judge an immutable report without replacing check evidence", async () => {
  const f = await fixture();
  try {
    const prompts = mockJudge(f);
    const measured = report(f.project.id, f.dir, true);
    f.store.patch(f.task.id, { judgeRetries: 3 });
    await writeFile(join(f.dir, "original-checks.json"), "checks");
    f.store.patch(f.task.id, { checks: [{ command: "npm test", code: 0 }], verification: { id: "checks" } });
    f.engine.browserAuditRunner = async options => {
      assert.equal(options.projectId, f.project.id);
      assert.equal(options.databasePath, join(f.dir, "looproom.sqlite"));
      assert.equal(options.timeoutMs, 30 * 60_000);
      assert.equal(options.snapshotId, undefined);
      return persist(f, measured);
    };
    await f.engine.judge(f.project, f.gate);
    assert.equal(prompts.length, 2, String(f.store.get(f.gate.id).judgeRecoveryError));
    assert.match(prompts[1], new RegExp(measured.id));
    assert.equal(f.store.get(f.project.id).browserBaseline.reportId, measured.id);
    assert.equal(f.store.get(f.task.id).browserVerification.status, "complete");
    assert.equal(f.store.get(f.gate.id).status, "resolved", "fresh measured evidence releases an exhausted retry round");
    assert.deepEqual(f.store.get(f.task.id).checks, [{ command: "npm test", code: 0 }]);
    assert.equal(f.store.get(f.task.id).verification.id, "checks");
    assert.equal(JSON.parse(await readFile(join(f.worktree, ".looproom-verification", measured.id + ".json"), "utf8")).id, measured.id);
    assert.equal(JSON.parse(await readFile(join(f.worktree, ".looproom-verification/browser-latest.json"), "utf8")).id, measured.id);
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});

test("unavailable browser evidence stays blocked and cannot pin a baseline", async () => {
  const f = await fixture();
  try {
    const prompts = mockJudge(f);
    const unavailable = report(f.project.id, f.dir, false);
    f.engine.browserAuditRunner = async () => persist(f, unavailable);
    await f.engine.judge(f.project, f.gate);
    assert.equal(prompts.length, 2);
    assert.equal(f.store.get(f.gate.id).status, "open");
    assert.equal(f.store.get(f.gate.id).awaitingCapability, true);
    assert.equal(f.store.get(f.task.id).browserVerification.status, "unavailable");
    assert.equal(f.store.get(f.project.id).browserBaseline, undefined);
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});

test("fresh complete browser evidence clears an exhausted judge retry round", async () => {
  const f = await fixture();
  try {
    f.store.patch(f.task.id, { judgeRetries: 3 });
    const measured = report(f.project.id, f.dir, true);
    f.engine.browserAuditRunner = async () => persist(f, measured);
    await f.engine.verifyBrowserBaseline(f.project, f.store.get(f.task.id), f.gate);
    assert.equal(f.store.get(f.task.id).judgeRetries, 0);
    assert.equal(f.store.get(f.task.id).browserVerification.status, "complete");
  } finally { await f.close(); }
});

test("unavailable browser diagnostics do not clear an exhausted retry round", async () => {
  const f = await fixture();
  try {
    f.store.patch(f.task.id, { judgeRetries: 3 });
    const unavailable = report(f.project.id, f.dir, false);
    f.engine.browserAuditRunner = async () => persist(f, unavailable);
    await f.engine.verifyBrowserBaseline(f.project, f.store.get(f.task.id), f.gate);
    assert.equal(f.store.get(f.task.id).judgeRetries, 3);
  } finally { await f.close(); }
});

test("browser runner error stays distinct from a measured report and keeps the gate open", async () => {
  const f = await fixture();
  try {
    mockJudge(f);
    f.engine.browserAuditRunner = async () => { throw new Error("Chrome launch failed"); };
    await f.engine.judge(f.project, f.gate);
    assert.equal(f.store.get(f.gate.id).status, "open");
    assert.match(f.store.get(f.gate.id).judgeRecoveryError, /Chrome launch failed/);
    assert.equal(f.store.get(f.task.id).browserVerification, undefined);
    assert.equal(f.store.get(f.project.id).browserBaseline, undefined);
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});

test("report file and source identity must match before worker handoff or baseline pin", async () => {
  const f = await fixture();
  try {
    const measured = report(f.project.id, f.dir, true);
    f.engine.browserAuditRunner = async () => {
      await persist(f, measured);
      await writeFile(join(f.worktree, "source-change.ts"), "changed after measurement");
      return measured;
    };
    await assert.rejects(f.engine.verifyBrowserBaseline(f.project, f.task, f.gate), /source changed during measurement/);
    assert.equal(f.store.get(f.project.id).browserBaseline, undefined);
    assert.equal(f.store.get(f.task.id).browserVerification, undefined);
  } finally { await f.close(); }
});

test("candidate browser recipe reuses the pinned actual-record snapshot and evaluator", async () => {
  const f = await fixture();
  try {
    const baseline = report(f.project.id, f.dir, true);
    f.engine.browserAuditRunner = async () => persist(f, baseline);
    await f.engine.verifyBrowserBaseline(f.project, f.task, f.gate);
    const pinned = f.store.get(f.project.id).browserBaseline;
    const candidate = f.store.put("task", { projectId: f.project.id, worktree: f.worktree, status: "blocked", acceptance: [] });
    const candidateReport = report(f.project.id, f.dir, true);
    f.engine.browserAuditRunner = async options => {
      assert.equal(options.snapshotId, pinned.snapshotId);
      candidateReport.sourceHash = await sourceFingerprint(f.worktree);
      candidateReport.snapshotId = pinned.snapshotId;
      candidateReport.snapshotHash = pinned.snapshotHash;
      await persistArtifacts(candidateReport);
      await writeFile(candidateReport.reportPath, JSON.stringify(candidateReport, null, 2) + "\n", { flag: "wx" });
      return candidateReport;
    };
    await f.engine.verifyBrowserBaseline(f.store.get(f.project.id), candidate);
    assert.equal(f.store.get(candidate.id).browserVerification.id, candidateReport.id);
    assert.equal(f.store.get(f.project.id).browserBaseline.reportId, baseline.id);
  } finally { await f.close(); }
});

test("fresh candidate receives frozen browser baseline by ID without replacing check or current browser reports", async () => {
  const f = await fixture();
  try {
    const baseline = report(f.project.id, f.dir, true);
    f.engine.browserAuditRunner = async () => persist(f, baseline);
    await f.engine.verifyBrowserBaseline(f.project, f.task, f.gate);
    const candidateTree = join(f.dir, "candidate");
    await mkdir(candidateTree);
    const candidate = f.store.put("task", { projectId: f.project.id, worktree: candidateTree, status: "ready" });
    const evidenceDir = join(candidateTree, ".looproom-verification");
    await mkdir(evidenceDir);
    await writeFile(join(evidenceDir, "latest.json"), "candidate checks");
    await writeFile(join(evidenceDir, "browser-latest.json"), "candidate browser report");
    (f.engine.runtime as any).run = async ({ cwd }: { cwd: string }) => {
      assert.equal(cwd, candidateTree);
      assert.deepEqual(await readFile(join(evidenceDir, "baseline-browser.json")), await readFile(baseline.reportPath));
      return JSON.stringify({ summary: "Candidate inspected baseline", sources: [], claims: [] });
    };
    await f.engine.run(f.store.get(f.project.id), "research", "Inspect frozen baseline",
      z.object({ summary: z.string(), sources: z.array(z.string()), claims: z.array(z.any()) }), candidate, false);
    await f.engine.handoffBrowserBaselineEvidence(f.store.get(f.project.id), candidate);
    const source = await readFile(baseline.reportPath);
    assert.deepEqual(await readFile(join(evidenceDir, baseline.id + ".json")), source);
    assert.deepEqual(await readFile(join(evidenceDir, "baseline-browser.json")), source);
    assert.equal(await readFile(join(evidenceDir, "latest.json"), "utf8"), "candidate checks");
    assert.equal(await readFile(join(evidenceDir, "browser-latest.json"), "utf8"), "candidate browser report");
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});

test("corrupt pinned browser report hash refuses candidate handoff", async () => {
  const f = await fixture();
  try {
    const baseline = report(f.project.id, f.dir, true);
    f.engine.browserAuditRunner = async () => persist(f, baseline);
    await f.engine.verifyBrowserBaseline(f.project, f.task, f.gate);
    f.store.patch(f.project.id, { browserBaseline: { ...f.store.get(f.project.id).browserBaseline,
      reportHash: "0".repeat(64) } });
    const candidateTree = join(f.dir, "candidate");
    await mkdir(candidateTree);
    const candidate = f.store.put("task", { projectId: f.project.id, worktree: candidateTree, status: "ready" });
    await assert.rejects(f.engine.handoffBrowserBaselineEvidence(f.store.get(f.project.id), candidate), /pinned hash/);
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});

test("damaged pinned browser evidence reaches judge as a recorded diagnostic while worker and review fail closed", async () => {
  const f = await fixture();
  try {
    const baseline = report(f.project.id, f.dir, true);
    f.engine.browserAuditRunner = async () => persist(f, baseline);
    await f.engine.verifyBrowserBaseline(f.project, f.task, f.gate);
    f.store.patch(f.project.id, { escalationMode: "human", browserBaseline: {
      ...f.store.get(f.project.id).browserBaseline, reportHash: "0".repeat(64) } });
    const candidateTree = join(f.dir, "candidate-judge");
    await mkdir(candidateTree);
    const candidate = f.store.put("task", { projectId: f.project.id, worktree: candidateTree,
      status: "blocked", title: "Candidate", acceptance: [], dependencies: [] });
    const candidateGate = f.engine.gate(f.project.id, "Candidate evidence", "Assess browser evidence", "review", candidate.id);
    let prompt = "";
    f.engine.runtime.run = async (options: any) => {
      prompt = options.prompt;
      return JSON.stringify({ action: "retry", answer: "Claim measured success", summary: "Untrusted report",
        sources: [], verificationRequests: [] });
    };
    await assert.rejects(f.engine.run(f.store.get(f.project.id), "implementation", "Worker", z.object({}), candidate, true), /pinned hash/);
    await assert.rejects(f.engine.run(f.store.get(f.project.id), "review", "Review", z.object({}), candidate), /pinned hash/);
    assert.equal(f.store.all("run").length, 0);
    await f.engine.judge(f.store.get(f.project.id), candidateGate);
    const judgeRun = f.store.all("run").findLast(run => run.role === "judge")!;
    assert.match(judgeRun.browserBaselineIntegrityError, /pinned hash/);
    assert.match(prompt, /Coordinator browser baseline integrity check failed/);
    assert.equal(f.store.get(candidateGate.id).judgeAction, "wait");
    assert.equal(f.store.get(candidateGate.id).status, "open");
    assert.equal(f.store.all("approval").length, 0);
    await assert.rejects(readFile(join(candidateTree, ".looproom-verification", "baseline-browser.json")), /ENOENT/);
  } finally { await f.close(); }
});

test("candidate handoff rejects corrupted or deleted pinned browser artifacts", async () => {
  const f = await fixture();
  try {
    const baseline = report(f.project.id, f.dir, true);
    f.engine.browserAuditRunner = async () => persist(f, baseline);
    await f.engine.verifyBrowserBaseline(f.project, f.task, f.gate);
    const candidateTree = join(f.dir, "candidate");
    await mkdir(candidateTree);
    const candidate = f.store.put("task", { projectId: f.project.id, worktree: candidateTree, status: "ready" });
    const artifact = baseline.artifacts[0];
    const original = await readFile(artifact);
    await writeFile(artifact, "tampered screenshot");
    await assert.rejects(f.engine.handoffBrowserBaselineEvidence(f.store.get(f.project.id), candidate), /recorded SHA-256/);
    await writeFile(artifact, original);
    await rm(artifact);
    await assert.rejects(f.engine.handoffBrowserBaselineEvidence(f.store.get(f.project.id), candidate), /missing, linked, or outside/);
    const linkedTarget = join(f.dir, "linked-screenshot.png");
    await writeFile(linkedTarget, original);
    await symlink(linkedTarget, artifact);
    await assert.rejects(f.engine.handoffBrowserBaselineEvidence(f.store.get(f.project.id), candidate), /missing, linked, or outside/);
    assert.equal(f.store.get(f.project.id).browserBaseline.reportId, baseline.id);
  } finally { await f.close(); }
});

test("complete browser report rejects an artifact outside its exact audit directory", async () => {
  const f = await fixture();
  try {
    const measured = report(f.project.id, f.dir, true);
    const outside = join(f.dir, "outside.png");
    const previous = measured.artifacts[0];
    measured.artifacts[0] = outside;
    measured.observations.samples[0].screenshot = outside;
    delete measured.artifactHashes[previous];
    f.engine.browserAuditRunner = async () => persist(f, measured);
    await assert.rejects(f.engine.verifyBrowserBaseline(f.project, f.task, f.gate), /outside its audit directory/);
    assert.equal(f.store.get(f.project.id).browserBaseline, undefined);
  } finally { await f.close(); }
});

test("pausing during browser run prevents automatic handoff or gate resolution", async () => {
  const f = await fixture();
  try {
    mockJudge(f);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.engine.browserAuditRunner = async () => { await pending; return persist(f, report(f.project.id, f.dir, true)); };
    const judging = f.engine.judge(f.project, f.gate);
    for (let i = 0; i < 50 && f.store.get(f.gate.id).judgeRecoveryStatus !== "verifying"; i++)
      await new Promise(resolve => setTimeout(resolve, 1));
    f.store.patch(f.project.id, { status: "paused" });
    release();
    await judging;
    assert.equal(f.store.get(f.gate.id).status, "open");
    assert.equal(f.store.get(f.project.id).browserBaseline, undefined);
    assert.equal(f.store.get(f.task.id).browserVerification, undefined);
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});

test("human gate response during browser run remains authoritative", async () => {
  const f = await fixture();
  try {
    mockJudge(f);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.engine.browserAuditRunner = async () => { await pending; return persist(f, report(f.project.id, f.dir, true)); };
    const judging = f.engine.judge(f.project, f.gate);
    for (let i = 0; i < 50 && f.store.get(f.gate.id).judgeRecoveryStatus !== "verifying"; i++)
      await new Promise(resolve => setTimeout(resolve, 1));
    await f.engine.resolve(f.gate.id, "Human supplied the needed context", true, "human");
    release();
    await judging;
    assert.equal(f.store.get(f.gate.id).status, "resolved");
    assert.equal(f.store.get(f.gate.id).resolvedBy, "human");
    assert.equal(f.store.get(f.project.id).browserBaseline, undefined);
    assert.equal(f.store.get(f.task.id).browserVerification, undefined);
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});
