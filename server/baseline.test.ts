import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.ts";
import { Store } from "./store.ts";
import type { Runtime } from "./runtime.ts";

const hash = (source: string) => createHash("sha256").update(source).digest("hex");
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "looproom-baseline-"));
  await mkdir(join(dir, "scripts"));
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, Object.assign(new EventEmitter(), { close() {} }) as Runtime, dir);
  const project = store.put("project", { path: dir, status: "running", checks: [], escalationMode: "yolo" });
  const task = store.put("task", { projectId: project.id, worktree: dir, status: "blocked", acceptance: [] });
  const source = join(dir, "scripts/measure-refresh.ts");
  await writeFile(source, "original");
  return { dir, store, engine, project, task, source, async close() {
    store.close(); await rm(dir, { recursive: true, force: true });
  } };
}
test("baseline setup repairs require independent review and fresh results before freezing; candidates cannot change the evaluator", async () => {
  const f = await fixture();
  try {
    await f.engine.verificationCommands(f.project, f.task, ["refresh-baseline"]);
    assert.equal(await f.engine.evaluatorSnapshot(hash("original")), "original");
    await writeFile(f.source, "cleanup repair");
    let reviews = 0;
    f.engine.run = async (_p, role, _prompt, _schema, task, write) => {
      assert.equal(role, "review"); assert.equal(write, false); assert.equal(task?.id, f.task.id);
      reviews++;
      return { baselineSetupOnly: true, measurementContractUnchanged: true, noCandidateResults: true, summary: "Cleanup repair before candidates", sources: ["scripts/measure-refresh.ts"] };
    };
    assert.deepEqual(await f.engine.verificationCommands(f.project, f.store.get(f.task.id), ["refresh-baseline"]), ["node --import tsx scripts/measure-refresh.ts"]);
    assert.equal(reviews, 1);
    assert.equal(f.store.get(f.project.id).refreshBaseline.revisions[0].previousHash, hash("original"));
    await assert.rejects(f.engine.freezeBaseline(f.project, f.store.get(f.task.id)), /successful verification/);
    f.store.patch(f.task.id, { judgeRetries: 3 });
    f.engine.verificationRunner = async () => ({ id: "fresh", sourceHash: "source", sourceUnchanged: true, createdAt: new Date().toISOString(), reportPath: "fixture", results: [{ command: "node --import tsx scripts/measure-refresh.ts", code: 0, output: "measurements", timedOut: false, durationMs: 1 }] });
    await f.engine.verify(f.project, f.task, ["node --import tsx scripts/measure-refresh.ts"]);
    assert.equal(f.store.get(f.task.id).judgeRetries, 0);
    await f.engine.freezeBaseline(f.project, f.store.get(f.task.id));
    assert.equal(f.store.get(f.project.id).refreshBaseline.phase, "frozen");
    await writeFile(f.source, "changed score");
    await assert.rejects(f.engine.verificationCommands(f.project, f.store.get(f.task.id), ["refresh-baseline"]), /Frozen refresh evaluator changed/);
    const candidate = f.store.put("task", { projectId: f.project.id, worktree: f.dir, status: "ready" });
    await assert.rejects(f.engine.verificationCommands(f.project, candidate, ["refresh-baseline"]), /Frozen refresh evaluator changed/);
    assert.equal(reviews, 1);
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});
test("rejected revisions and source races retain the old baseline; candidate measurement waits for setup", async () => {
  const f = await fixture();
  try {
    await f.engine.verificationCommands(f.project, f.task, ["refresh-baseline"]);
    const candidate = f.store.put("task", { projectId: f.project.id, worktree: f.dir, status: "ready" });
    await assert.rejects(f.engine.verificationCommands(f.project, candidate, ["refresh-baseline"]), /Finish and review/);
    await writeFile(f.source, "changed score");
    f.engine.run = async () => ({ baselineSetupOnly: true, measurementContractUnchanged: false, noCandidateResults: true, summary: "Metric changed", sources: [] });
    await assert.rejects(f.engine.verificationCommands(f.project, f.task, ["refresh-baseline"]), /not accepted/);
    assert.equal(f.store.get(f.project.id).refreshBaseline.evaluatorHash, hash("original"));
    f.engine.run = async () => {
      await writeFile(f.source, "race");
      return { baselineSetupOnly: true, measurementContractUnchanged: true, noCandidateResults: true, summary: "Repair", sources: [] };
    };
    await assert.rejects(f.engine.verificationCommands(f.project, f.task, ["refresh-baseline"]), /changed during revision review/);
    assert.equal(f.store.get(f.project.id).refreshBaseline.evaluatorHash, hash("original"));
  } finally { await f.close(); }
});
test("a refused verification recipe reaches YOLO recovery with the actual error instead of transport cooldown", async () => {
  const f = await fixture();
  try {
    f.engine.run = async () => ({ action: "retry", answer: "Measure", summary: "Need baseline", sources: [], verificationRequests: ["refresh-baseline"] });
    const gate = f.engine.gate(f.project.id, "Missing baseline", "Need measurement", "review", f.task.id);
    f.engine.verificationCommands = async () => { throw new Error("Pinned evaluator mismatch"); };
    let recovered = false;
    f.engine.recoverEscalation = async (_project, _gate, _task, assessment) => {
      recovered = true; assert.match(assessment.answer, /Pinned evaluator mismatch/);
      // The normal runtime creates a run; this fixture substitutes that boundary.
      f.store.put("run", { projectId: f.project.id, role: "judge" });
      return { ...assessment, action: "wait", answer: "Restore the fixed evaluator first" };
    };
    await f.engine.judge(f.project, gate);
    assert.equal(recovered, true);
    assert.equal(f.store.get(gate.id).judgeStatus, "answered");
    assert.equal(f.store.get(gate.id).judgeFailures, 0);
    assert.equal(f.store.get(gate.id).awaitingCapability, true);
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});
test("evaluator snapshots preserve original bytes and reject missing legacy evidence or tampering", async () => {
  const f = await fixture();
  try {
    f.store.patch(f.task.id, { verificationEvaluatorHash: hash("lost legacy source") });
    await assert.rejects(f.engine.verificationCommands(f.project, f.store.get(f.task.id), ["refresh-baseline"]), /Original evaluator source is missing/);
    const path = join(f.dir, "verification/evaluators", hash("original") + ".ts");
    assert.equal(await readFile(path, "utf8"), "original");
    await assert.rejects(f.engine.evaluatorSnapshot(hash("original"), Buffer.from("tampered")), /does not match/);
    assert.equal(await readFile(path, "utf8"), "original");
    await writeFile(path, "tampered");
    await assert.rejects(f.engine.evaluatorSnapshot(hash("original"), Buffer.from("original")), /snapshot was changed/);
    assert.equal(await readFile(path, "utf8"), "tampered", "Never silently overwrite immutable evidence");
  } finally { await f.close(); }
});
