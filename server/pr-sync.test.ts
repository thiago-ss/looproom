import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Engine } from "./engine.ts";
import { Store } from "./store.ts";
import type { Runtime } from "./runtime.ts";
import { createRepo, createWorktree, git } from "./git.ts";
import { testFixture } from "./test-fixtures.ts";

const head = "a".repeat(40), merged = "b".repeat(40), url = "https://github.com/example/repo/pull/1";
async function fixture(status = "running") {
  const dir = await testFixture("pr-sync-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, Object.assign(new EventEmitter(), { close() {} }) as Runtime, dir);
  store.put("settings", { concurrency: 2 }, "settings");
  const project = store.put("project", { status, path: dir, github: "example/repo", branch: "main", planned: true, escalationMode: "human" });
  const task = store.put("task", { projectId: project.id, status: "awaiting_human", dependencies: [], title: "Parent", pr: url, sha: head });
  const gate = store.put("gate", { projectId: project.id, taskId: task.id, status: "open", type: "pr", judgeStatus: "answered", sha: head, pr: url });
  let info: any = { number: 1, url, baseRefName: "main", headRefOid: head, state: "MERGED", mergedAt: new Date().toISOString(), mergeCommit: { oid: merged }, mergeable: "MERGEABLE" };
  const calls: string[][] = [];
  engine.mergeBroker = async args => { calls.push(args); assert.equal(args[0], "pr"); return JSON.stringify(info); };
  engine.gitRunner = async (_path, args) => args[0] === "rev-parse" ? merged : "";
  return { dir, store, engine, project, task, gate, calls, setInfo(next: any) { info = { ...info, ...next }; }, async close() { engine.close(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("external merges clear stale review and immediately dispatch a dependent exactly once without approvals", async () => {
  const f = await fixture();
  let starts = 0;
  try {
    const child = f.store.put("task", { projectId: f.project.id, status: "ready", dependencies: [f.task.id], title: "Child" });
    f.engine.implement = async (_project, task) => { assert.equal(task.id, child.id); starts++; f.store.patch(task.id, { status: "running" }); };
    await f.engine.syncProject(f.project.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 1);
    assert.equal(f.store.get(f.gate.id).status, "reconciled");
    assert.equal(f.store.get(f.task.id).status, "completed");
    assert.equal(f.store.all("approval").length, 0);
    assert.equal(f.store.all("message").length, 1);
    await f.engine.syncProject(f.project.id);
    assert.equal(f.store.all("message").length, 1);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("paused projects reconcile external facts and retain conflict repair until resumed", async () => {
  const f = await fixture("paused");
  try {
    f.setInfo({ state: "OPEN", mergeable: "CONFLICTING", mergedAt: null, mergeCommit: null });
    let starts = 0;
    f.engine.implement = async (_p, task) => { starts++; f.store.patch(task.id, { status: "running" }); };
    await f.engine.syncProject(f.project.id);
    assert.equal(starts, 0);
    assert.equal(f.store.get(f.gate.id).status, "superseded");
    assert.equal(f.store.get(f.task.id).status, "ready");
    assert.equal(f.store.get(f.task.id).review, null);
    assert.equal(f.store.get(f.task.id).prRepair.expectedHead, head);
    f.store.patch(f.project.id, { status: "running" });
    f.engine.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 1);
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});

test("sync reservations, unavailable GitHub and invalid identities never change task or merge authority", async () => {
  const f = await fixture("paused");
  try {
    f.engine.prDecisionBusy.add(f.gate.id);
    await f.engine.syncProject(f.project.id);
    assert.equal(f.calls.length, 0);
    f.engine.prDecisionBusy.clear();
    for (const patch of [{ url: "https://github.com/other/repo/pull/1" }, { url, baseRefName: "other" }, { url, baseRefName: "main", mergeCommit: null }]) {
      f.setInfo(patch);
      await f.engine.syncProject(f.project.id);
      assert.equal(f.store.get(f.gate.id).status, "open");
      assert.equal(f.store.get(f.task.id).status, "awaiting_human");
    }
    f.engine.mergeBroker = async () => { throw new Error("GitHub unavailable"); };
    await f.engine.syncProject(f.project.id);
    assert.ok(f.engine.nextRemoteSync.get(f.project.id)! > Date.now() + 15_000);
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});

test("sync is single flight and late GitHub replies cannot mutate a closed coordinator", async () => {
  const f = await fixture("paused");
  let release!: () => void;
  try {
    const held = new Promise<void>(resolve => { release = resolve; });
    f.engine.mergeBroker = async () => { await held; return JSON.stringify({ number: 1, url, baseRefName: "main", headRefOid: head, state: "MERGED", mergedAt: new Date().toISOString(), mergeCommit: { oid: merged } }); };
    const pending = f.engine.syncProject(f.project.id);
    await f.engine.syncProject(f.project.id);
    f.engine.close(); release(); await pending;
    assert.equal(f.store.get(f.gate.id).status, "open");
    assert.equal(f.store.all("message").length, 0);
  } finally { release?.(); await f.close(); }
});

test("external merge evidence replays only to its exact originating run and keeps raw bytes immutable", async () => {
  const f = await fixture("paused");
  try {
    const run = f.store.put("run", { projectId: f.project.id, taskId: f.task.id, role: "implementation", status: "completed", prEvidence: { url, headSha: head, status: "awaiting_human" } });
    f.store.patch(f.gate.id, { prRunId: run.id });
    await f.engine.document(f.project.id, "Implementation", "Outcome", [url], run.id);
    const rawPath = join(f.dir, "wiki", f.project.id, "raw", run.id + ".json");
    const raw = await readFile(rawPath);
    await f.engine.syncProject(f.project.id);
    await f.engine.recoverWiki();
    assert.equal(f.store.get(run.id).prEvidence.status, "merged");
    assert.equal(f.store.get(run.id).prEvidence.mergeActor, "unverified");
    assert.deepEqual(await readFile(rawPath), raw);
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});

test("a remotely merged different head is recorded without borrowing the earlier review", async () => {
  const f = await fixture("paused");
  try {
    const run = f.store.put("run", { projectId: f.project.id, taskId: f.task.id, role: "implementation", status: "completed", prEvidence: { url, headSha: head, status: "awaiting_human" } });
    f.store.patch(f.gate.id, { prRunId: run.id });
    f.setInfo({ headRefOid: "c".repeat(40) });
    await f.engine.syncProject(f.project.id);
    assert.equal(f.store.get(f.gate.id).status, "reconciled");
    assert.match(f.store.get(f.gate.id).mergeRecovery, /earlier review does not authorize/);
    assert.equal(f.store.get(run.id).prEvidence.status, "awaiting_human");
  } finally { await f.close(); }
});

test("real Git integration preserves dirty primary checkout, resolves markers and returns a new verified PR head", async () => {
  const f = await fixture("paused");
  try {
    const repo = await createRepo(join(f.dir, "repo"));
    await git(repo.path, ["config", "user.name", "Fixture"]);
    await git(repo.path, ["config", "user.email", "fixture@localhost"]);
    await writeFile(join(repo.path, "shared.txt"), "original\n");
    await git(repo.path, ["add", "."]); await git(repo.path, ["commit", "-m", "Base"]);
    const origin = join(f.dir, "origin.git");
    await git(repo.path, ["clone", "--bare", repo.path, origin]);
    await git(repo.path, ["remote", "add", "origin", origin]);
    const tree = await createWorktree(repo.path, f.dir, f.task.id);
    await writeFile(join(tree.path, "shared.txt"), "task change\n");
    await git(tree.path, ["add", "."]); await git(tree.path, ["commit", "-m", "Task"]);
    await git(tree.path, ["push", "origin", tree.branch]);
    const taskHead = await git(tree.path, ["rev-parse", "HEAD"]);
    await writeFile(join(repo.path, "shared.txt"), "merged change\n");
    await git(repo.path, ["add", "."]); await git(repo.path, ["commit", "-m", "Remote base"]);
    await git(repo.path, ["push", "origin", "main"]);
    const baseSha = await git(repo.path, ["rev-parse", "HEAD"]);
    await writeFile(join(repo.path, "shared.txt"), "user unsaved work\n");
    const project = f.store.patch(f.project.id, { path: repo.path, checks: ["fixture-check"] });
    f.store.patch(f.task.id, { worktree: tree.path, branch: tree.branch, kind: "implementation", attempt: 0, acceptance: ["Both changes"], description: "Integrate" });
    f.store.patch(f.gate.id, { sha: taskHead });
    f.setInfo({ state: "OPEN", mergeable: "CONFLICTING", headRefOid: taskHead });
    f.engine.gitRunner = git;
    await f.engine.syncProject(project.id);
    let task = await f.engine.preparePrRepair(project, f.store.get(f.task.id));
    assert.match(await readFile(join(tree.path, "shared.txt"), "utf8"), /<<<<<<< /);
    // Restart between coordinator integration and worker writes preserves the merge intent.
    task = await f.engine.preparePrRepair(project, task);
    assert.equal(task.prRepair.baseSha, baseSha);
    await assert.rejects(f.engine.stagePrConflicts(task), /Unresolved conflict markers/);
    await writeFile(join(tree.path, "shared.txt"), "merged change\ntask change\n");
    await f.engine.stagePrConflicts(task);
    assert.equal(await git(tree.path, ["diff", "--name-only", "--diff-filter=U"]), "");
    assert.match(await git(tree.path, ["diff", "HEAD"]), /task change/);
    f.store.patch(project.id, { status: "running" });
    f.engine.run = (async (_p: any, role: string, prompt: string) => {
      if (role === "implementation") return { summary: "Integrated", sources: ["shared.txt"], humanQuestion: "", claims: [] };
      assert.equal(role, "review");
      assert.ok(prompt.includes("git diff " + baseSha));
      assert.match(await git(tree.path, ["diff", "HEAD"]), /merged change/);
      return { verdict: "pass", summary: "Fixture independent review", sources: ["shared.txt"], claims: [] };
    }) as Engine["run"];
    f.engine.verify = async (_p, t) => {
      assert.equal(await readFile(join(t.worktree, "shared.txt"), "utf8"), "merged change\ntask change\n");
      f.store.patch(t.id, { checks: [{ command: "fixture-check", code: 0, output: "fixture" }] });
      return { sourceUnchanged: true, results: [{ command: "fixture-check", code: 0, output: "fixture" }] } as any;
    };
    f.engine.githubRunner = async args => { assert.equal(args[0], "auth"); return "fixture"; };
    await f.engine.implement(f.store.get(project.id), task);
    const published = f.store.get(task.id);
    assert.equal(published.status, "awaiting_human");
    assert.notEqual(published.sha, taskHead);
    assert.equal(await git(tree.path, ["rev-parse", "HEAD^2"]), baseSha);
    assert.equal(await git(tree.path, ["rev-parse", "origin/" + tree.branch]), published.sha);
    assert.equal(await readFile(join(repo.path, "shared.txt"), "utf8"), "user unsaved work\n");
    assert.equal(f.store.all("gate").filter(g => g.type === "pr" && g.status === "open").length, 1);
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});

test("retargeted approvals and incomplete interrupted merge facts fail closed without a merge PUT", async () => {
  const f = await fixture("paused");
  try {
    f.setInfo({ state: "OPEN", baseRefName: "another-base", statusCheckRollup: [] });
    await assert.rejects(f.engine.approve(f.gate.id, head), /base|identity/);
    assert.equal(f.store.get(f.gate.id).mergeAttempt, undefined);
    f.store.patch(f.gate.id, { status: "merging", mergeAttempt: { pr: url, number: 1, reviewedSha: head, requestedAt: "fixture" } });
    for (const patch of [
      { state: "MERGED", baseRefName: "another-base" },
      { state: "MERGED", baseRefName: "main", mergeCommit: null },
      { state: "MERGED", baseRefName: "main", mergeCommit: { oid: merged }, mergedAt: null },
      { state: "MERGED", mergedAt: "invalid date" },
    ]) {
      f.setInfo(patch);
      await assert.rejects(f.engine.reconcileMerge(f.gate.id), /base|identity|complete merge evidence/);
      assert.equal(f.store.get(f.task.id).status, "awaiting_human");
      assert.equal(f.store.get(f.gate.id).status, "merging");
    }
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});

test("late interrupted merge reconciliation respects shutdown and the shared decision reservation", async () => {
  const f = await fixture("paused");
  let release!: () => void;
  try {
    f.store.patch(f.gate.id, { status: "merging", mergeAttempt: { pr: url, number: 1, reviewedSha: head, requestedAt: "fixture" } });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.engine.mergeBroker = async () => { await held; return JSON.stringify({ number: 1, url, baseRefName: "main", headRefOid: head, state: "MERGED", mergedAt: new Date().toISOString(), mergeCommit: { oid: merged } }); };
    const pending = f.engine.reconcileMerge(f.gate.id);
    await assert.rejects(f.engine.reconcileMerge(f.gate.id), /already being submitted/);
    f.engine.close(); release(); await pending;
    assert.equal(f.store.get(f.gate.id).status, "merging");
    assert.equal(f.store.get(f.task.id).status, "awaiting_human");
    assert.equal(f.store.all("approval").length, 0);
  } finally { release?.(); await f.close(); }
});

test("interrupted merge reconciliation persists the complete validated GitHub observation", async () => {
  const f = await fixture("paused");
  try {
    f.store.patch(f.gate.id, { status: "merging", mergeAttempt: { pr: url, number: 1, reviewedSha: head, requestedAt: "fixture" } });
    await f.engine.reconcileMerge(f.gate.id);
    const gate = f.store.get(f.gate.id);
    assert.equal(gate.status, "reconciled");
    assert.equal(gate.remoteObservation.url, url);
    assert.equal(gate.remoteObservation.number, 1);
    assert.equal(gate.remoteObservation.base, "main");
    assert.equal(gate.remoteObservation.headSha, head);
    assert.equal(gate.remoteObservation.mergedSha, merged);
    assert.ok(Number.isFinite(Date.parse(gate.remoteObservation.mergedAt)));
    assert.equal(f.store.all("approval").length, 0);
  } finally { await f.close(); }
});

test("a late request-changes reply cannot resolve a review after shutdown", async () => {
  const f = await fixture("paused");
  let release!: () => void;
  try {
    const held = new Promise<void>(resolve => { release = resolve; });
    f.engine.prInfo = async () => { await held; return { state: "OPEN", headRefOid: head }; };
    const pending = f.engine.requestChanges(f.gate.id, head, "Make a revision");
    f.engine.close(); release(); await pending;
    assert.equal(f.store.get(f.gate.id).status, "open");
    assert.equal(f.store.get(f.task.id).status, "awaiting_human");
    assert.equal(f.store.all("message").length, 0);
  } finally { release?.(); await f.close(); }
});

test("a different final merged head releases an uncertain attempt without borrowing its approval or wiki review", async () => {
  const f = await fixture("paused");
  try {
    const run = f.store.put("run", { projectId: f.project.id, taskId: f.task.id, role: "implementation", status: "completed", prEvidence: { url, headSha: head, status: "awaiting_human" } });
    await f.engine.document(f.project.id, "Attempted revision", "Old head outcome", [url], run.id);
    await f.engine.recordRunEvidence(f.task.id, { prEvidence: { url, headSha: head, status: "awaiting_human" } }, run.id);
    const rawPath = join(f.dir, "wiki", f.project.id, "raw", run.id + ".json");
    const raw = await readFile(rawPath);
    const attempt = { pr: url, number: 1, reviewedSha: head, prRunId: run.id, requestedAt: "fixture" };
    f.store.patch(f.gate.id, { status: "open", mergeAttempt: attempt });
    const finalHead = "c".repeat(40);
    f.setInfo({ headRefOid: finalHead });
    await f.engine.syncProject(f.project.id);
    assert.equal(f.store.get(f.gate.id).status, "reconciled");
    assert.equal(f.store.get(f.task.id).status, "completed");
    assert.deepEqual(f.store.get(f.gate.id).mergeAttempt, attempt);
    assert.equal(f.store.get(f.gate.id).remoteObservation.headSha, finalHead);
    assert.match(f.store.get(f.gate.id).mergeRecovery, /earlier review does not authorize/);
    await f.engine.recoverWiki();
    assert.equal(f.store.get(run.id).prEvidence.status, "awaiting_human");
    assert.equal(f.store.get("memory:" + run.id).prEvidence.status, "awaiting_human");
    assert.deepEqual(await readFile(rawPath), raw);
    assert.equal(f.store.all("approval").length, 0);
    await assert.rejects(f.engine.approve(f.gate.id, finalHead), /no longer open/);
  } finally { await f.close(); }
});
