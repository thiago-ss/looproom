import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { Runtime } from "./runtime.ts";
import { testFixture } from "./test-fixtures.ts";
import { z } from "zod";

for (const stage of ["intent", "raw", "manifest", "memory", "page", "index", "log"]) {
  test("wiki replay after " + stage, async () => {
    const dir = await testFixture("looproom-wiki-");
    const path = join(dir, "db");
    let store = new Store(path);
    const runtime = { close() {} } as unknown as Runtime;
    let engine = new Engine(store, runtime, dir);
    try {
      store.put("run", { projectId: "p", taskId: "t", status: "completed", output: "first" }, "r");
      engine.wikiFailureStage = stage;
      await assert.rejects(engine.document("p", "Result", "First claim.", ["source-a"], "r"), /Injected wiki failure/);
      store.close();
      store = new Store(path);
      engine = new Engine(store, runtime, dir);
      await engine.recoverWiki();
      const folder = join(dir, "wiki", "p");
      const raw = await readFile(join(folder, "raw", "r.json"));
      const hash = createHash("sha256").update(raw).digest("hex");
      const manifest = JSON.parse(await readFile(join(folder, "raw", "manifest.json"), "utf8"));
      assert.equal(manifest.sources.length, 1);
      assert.equal(manifest.sources[0].sha256, hash);
      assert.equal(store.all("memory", "p").length, 1);
      assert.equal(store.search("p", "First").length, 1);
      assert.equal(store.search("other", "First").length, 0);
      assert.match(await readFile(join(folder, "memory:r.md"), "utf8"), /First claim/);
      assert.equal((await readFile(join(folder, "index.md"), "utf8")).match(/memory:r.md/g)?.length, 1);
      assert.equal((await readFile(join(folder, "log.md"), "utf8")).match(/; page memory:r\./g)?.length, 1);
      await engine.recoverWiki();
      assert.deepEqual(await readFile(join(folder, "raw", "r.json")), raw);
      assert.equal(store.all("memory", "p").length, 1);
      assert.equal((await readFile(join(folder, "log.md"), "utf8")).match(/; page memory:r\./g)?.length, 1);
    } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
  });
}

test("project replay repairs an earlier outcome in log order without rewriting settled files", async () => {
  const dir = await testFixture("looproom-wiki-ordered-");
  const path = join(dir, "db");
  let store = new Store(path);
  const runtime = { close() {} } as unknown as Runtime;
  let engine = new Engine(store, runtime, dir);
  try {
    store.put("run", { projectId: "p", status: "completed", output: "earlier" }, "a");
    engine.wikiFailureStage = "memory";
    await assert.rejects(engine.document("p", "Earlier", "First outcome", ["source-a"], "a"), /Injected wiki failure/);
    store.patch("wiki-ingest:a", { capturedAt: "2026-01-01T00:00:00.000Z" });
    engine.wikiFailureStage = undefined;
    store.put("run", { projectId: "p", status: "completed", output: "later" }, "b");
    await engine.document("p", "Later", "Second outcome", ["source-b"], "b");
    store.patch("wiki-ingest:b", { capturedAt: "2026-01-02T00:00:00.000Z" });
    const folder = join(dir, "wiki", "p");
    const laterPage = join(folder, "memory:b.md");
    const index = join(folder, "index.md");
    const before = { page: await stat(laterPage), index: await stat(index) };
    store.close();
    store = new Store(path);
    engine = new Engine(store, runtime, dir);
    await engine.recoverWiki();
    const first = {
      page: await stat(laterPage), index: await stat(index),
      log: await readFile(join(folder, "log.md"), "utf8"),
    };
    await engine.recoverWiki();
    const second = {
      page: await stat(laterPage), index: await stat(index),
      log: await readFile(join(folder, "log.md"), "utf8"),
    };
    assert.equal(first.page.ino, before.page.ino);
    assert.equal(first.index.ino, before.index.ino);
    assert.equal(second.page.ino, first.page.ino);
    assert.equal(second.index.ino, first.index.ino);
    assert.equal(second.log, first.log);
    assert.ok(first.log.indexOf("Run a; page memory:a.") < first.log.indexOf("Run b; page memory:b."));
    for (const id of ["a", "b"]) {
      const raw = await readFile(join(folder, "raw", id + ".json"));
      const manifest = JSON.parse(await readFile(join(folder, "raw", "manifest.json"), "utf8"));
      assert.equal(manifest.sources.find((entry: any) => entry.file === id + ".json").sha256,
        createHash("sha256").update(raw).digest("hex"));
      assert.equal(first.log.match(new RegExp("; page memory:" + id + "\\.", "g"))?.length, 1);
      assert.match(await readFile(join(folder, "memory:" + id + ".md"), "utf8"), id === "a" ? /First outcome/ : /Second outcome/);
      assert.equal((await readFile(index, "utf8")).match(new RegExp("memory:" + id + "\\.md", "g"))?.length, 1);
    }
    assert.equal(store.all("memory", "p").length, 2);
    assert.equal(store.search("p", "First").length, 1);
    assert.equal(store.search("p", "Second").length, 1);
    assert.equal(store.search("other", "First").length, 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});

test("legacy log entries keep their UUID page links and raw evidence through new ingestion and replay", async () => {
  const dir = await testFixture("looproom-wiki-legacy-");
  const path = join(dir, "db");
  let store = new Store(path);
  const runtime = { close() {} } as unknown as Runtime;
  let engine = new Engine(store, runtime, dir);
  try {
    const folder = join(dir, "wiki", "p");
    await mkdir(join(folder, "raw"), { recursive: true });
    store.put("run", { projectId: "p", status: "completed", output: "legacy evidence" }, "old-run");
    const legacy = store.memory("p", "Legacy", "Historical outcome", ["old-source"]);
    store.patch(legacy.id, { runId: "old-run" });
    const oldPage = join(folder, legacy.id + ".md");
    const oldPageBytes = "# Legacy\n\nHistorical outcome\n\n[Original raw](raw/old-run.json)\n";
    await writeFile(oldPage, oldPageBytes);
    const oldRaw = Buffer.from('{"old":"capture","bytes":"unchanged"}\n');
    await writeFile(join(folder, "raw", "old-run.json"), oldRaw);
    const oldHash = createHash("sha256").update(oldRaw).digest("hex");
    await writeFile(join(folder, "raw", "manifest.json"), JSON.stringify({ sources: [
      { file: "old-run.json", sha256: oldHash, capturedAt: "2025-01-01T00:00:00.000Z", origin: "codex-run:old-run" },
    ] }, null, 2));
    const legacyEntry = "\n## [2025-01-01T00:00:00.000Z] outcome | Original title\n\nRun old-run; page " + legacy.id + ".\n";
    await writeFile(join(folder, "log.md"), "# Memory log\n" + legacyEntry);

    store.put("run", { projectId: "p", status: "completed", output: "new evidence" }, "new-run");
    await engine.document("p", "New", "Current outcome", ["new-source"], "new-run");
    const logPath = join(folder, "log.md");
    const indexPath = join(folder, "index.md");
    const before = { log: await stat(logPath), page: await stat(oldPage), index: await stat(indexPath) };
    store.close();
    store = new Store(path);
    engine = new Engine(store, runtime, dir);
    await engine.recoverWiki();
    await engine.recoverWiki();

    const log = await readFile(logPath, "utf8");
    assert.ok(log.includes(legacyEntry));
    assert.equal(log.match(/Run old-run; page /g)?.length, 1);
    assert.equal(log.match(/Run new-run; page memory:new-run\./g)?.length, 1);
    assert.ok(log.indexOf("Run old-run;") < log.indexOf("Run new-run;"));
    assert.deepEqual(await readFile(join(folder, "raw", "old-run.json")), oldRaw);
    assert.equal(await readFile(oldPage, "utf8"), oldPageBytes);
    const manifest = JSON.parse(await readFile(join(folder, "raw", "manifest.json"), "utf8"));
    assert.equal(manifest.sources.find((item: any) => item.file === "old-run.json").sha256, oldHash);
    const newRaw = await readFile(join(folder, "raw", "new-run.json"));
    assert.equal(manifest.sources.find((item: any) => item.file === "new-run.json").sha256,
      createHash("sha256").update(newRaw).digest("hex"));
    const index = await readFile(indexPath, "utf8");
    assert.match(index, new RegExp(legacy.id + "\\.md"));
    assert.match(index, /memory:new-run\.md/);
    assert.match(await readFile(join(folder, "memory:new-run.md"), "utf8"), /Current outcome/);
    assert.equal(store.search("p", "Historical").length, 1);
    assert.equal(store.search("p", "Current").length, 1);
    assert.equal(store.search("other", "Historical Current").length, 0);
    assert.equal((await stat(logPath)).ino, before.log.ino);
    assert.equal((await stat(oldPage)).ino, before.page.ino);
    assert.equal((await stat(indexPath)).ino, before.index.ino);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});

test("unparseable legacy log stops reconciliation before replacing the log", async () => {
  const dir = await testFixture("looproom-wiki-bad-log-");
  const store = new Store(join(dir, "db"));
  try {
    const folder = join(dir, "wiki", "p");
    await mkdir(folder, { recursive: true });
    const logPath = join(folder, "log.md");
    const original = "# Memory log\n\n## [2025-01-01T00:00:00.000Z] outcome | Incomplete\n";
    await writeFile(logPath, original);
    store.put("run", { projectId: "p", status: "completed" }, "r");
    await assert.rejects(new Engine(store, { close() {} } as unknown as Runtime, dir)
      .document("p", "New", "Outcome", ["source"], "r"), /Unparseable wiki log entry/);
    assert.equal(await readFile(logPath, "utf8"), original);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});

test("claim conflicts retain both sources even when an agent proposes supersession", async () => {
  const dir = await testFixture("looproom-claims-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, { close() {} } as unknown as Runtime, dir);
  try {
    for (const id of ["a", "b", "c"]) store.put("run", { projectId: "p", status: "completed" }, id);
    await engine.document("p", "Earlier", "Claim A", ["source-a"], "a", [{ key: "runtime", statement: "A", sources: ["source-a"], relation: "new" }]);
    await engine.document("p", "Conflict", "Claim B", ["source-b"], "b", [{ key: "runtime", statement: "B", sources: ["source-b"], relation: "contradicts" }]);
    assert.equal(store.get("memory:a").claimRevisions[0].status, "unresolved");
    assert.equal(store.get("memory:b").claimRevisions[0].status, "unresolved");
    await engine.document("p", "Revision", "Claim C", ["source-c"], "c", [{ key: "runtime", statement: "C", sources: ["source-c"], relation: "supersedes" }]);
    assert.equal(store.get("memory:a").claimRevisions[0].status, "unresolved");
    assert.equal(store.get("memory:b").claimRevisions[0].status, "unresolved");
    assert.equal(store.get("memory:c").claimRevisions[0].status, "unresolved");
    assert.match(await readFile(join(dir, "wiki", "p", "memory:a.md"), "utf8"), /source-b/);
    store.put("run", { projectId: "p", status: "completed" }, "d");
    await engine.document("p", "Agent alias", "Claim D", ["primary-looking-name"], "d", [{ key: "runtime", statement: "D", sources: ["primary-looking-name"], relation: "supersedes" }]);
    assert.equal(store.get("memory:a").claimRevisions[0].status, "unresolved");
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});

test("a lone agent supersession stays visibly proposed after restart", async () => {
  const dir = await testFixture("looproom-lone-supersession-");
  const path = join(dir, "db");
  let store = new Store(path);
  try {
    store.put("run", { projectId: "p", status: "completed" }, "r");
    await new Engine(store, { close() {} } as unknown as Runtime, dir).document(
      "p", "Proposal", "New claim", ["source-a"], "r",
      [{ key: "runtime", statement: "New claim", sources: ["source-a"], relation: "supersedes" }],
    );
    store.close();
    store = new Store(path);
    await new Engine(store, { close() {} } as unknown as Runtime, dir).recoverWiki();
    const claim = store.get("memory:r").claimRevisions[0];
    assert.equal(claim.status, "unresolved");
    assert.equal(claim.relation, "supersedes");
    assert.match(await readFile(join(dir, "wiki", "p", "memory:r.md"), "utf8"), /unresolved; proposed supersession/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});

test("differing claims in one run retain distinct unresolved source links after restart", async () => {
  const dir = await testFixture("looproom-same-page-conflict-");
  const path = join(dir, "db");
  let store = new Store(path);
  try {
    store.put("run", { projectId: "p", status: "completed" }, "r");
    await new Engine(store, { close() {} } as unknown as Runtime, dir).document(
      "p", "Conflicting outcome", "Three agent statements", ["run-source"], "r", [
        { key: " Runtime ", statement: "A", sources: ["source-a"], relation: "new" },
        { key: "runtime", statement: "B", sources: ["source-b"], relation: "new" },
        { key: "RUNTIME", statement: "C", sources: ["source-c"], relation: "new" },
      ],
    );
    const rawPath = join(dir, "wiki", "p", "raw", "r.json");
    const raw = await readFile(rawPath);
    store.close();
    store = new Store(path);
    await new Engine(store, { close() {} } as unknown as Runtime, dir).recoverWiki();
    const revisions = store.get("memory:r").claimRevisions;
    assert.deepEqual(revisions.map((claim: any) => claim.status), ["unresolved", "unresolved", "unresolved"]);
    assert.deepEqual(revisions[0].related.map((item: any) => [item.pageId, item.claimIndex, item.sources]), [
      ["memory:r", 1, ["source-b"]], ["memory:r", 2, ["source-c"]],
    ]);
    assert.deepEqual(revisions[1].related.map((item: any) => [item.pageId, item.claimIndex, item.sources]), [
      ["memory:r", 0, ["source-a"]], ["memory:r", 2, ["source-c"]],
    ]);
    const markdown = await readFile(join(dir, "wiki", "p", "memory:r.md"), "utf8");
    for (const source of ["source-a", "source-b", "source-c"]) assert.match(markdown, new RegExp(source));
    assert.match(markdown, /Conflicts with \[memory:r claim 2\]\(memory:r\.md\)/);
    assert.match(markdown, /Conflicts with \[memory:r claim 3\]\(memory:r\.md\)/);
    assert.deepEqual(await readFile(rawPath), raw);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});

test("a lone agent contradiction stays visibly proposed and unresolved after restart", async () => {
  const dir = await testFixture("looproom-lone-contradiction-");
  const path = join(dir, "db");
  let store = new Store(path);
  try {
    store.put("run", { projectId: "p", status: "completed" }, "r");
    await new Engine(store, { close() {} } as unknown as Runtime, dir).document(
      "p", "Proposal", "Uncorroborated conflict", ["run-source"], "r",
      [{ key: "runtime", statement: "Conflicting claim", sources: ["claim-source"], relation: "contradicts" }],
    );
    store.close();
    store = new Store(path);
    await new Engine(store, { close() {} } as unknown as Runtime, dir).recoverWiki();
    const claim = store.get("memory:r").claimRevisions[0];
    assert.equal(claim.status, "unresolved");
    assert.equal(claim.relation, "contradicts");
    assert.deepEqual(claim.sources, ["claim-source"]);
    assert.deepEqual(claim.related, []);
    assert.match(await readFile(join(dir, "wiki", "p", "memory:r.md"), "utf8"),
      /\*\*unresolved; proposed contradiction\*\* runtime: Conflicting claim \(sources: claim-source\)/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});

test("approved PR evidence survives restart replay without changing raw capture", async () => {
  const dir = await testFixture("looproom-merged-replay-");
  const path = join(dir, "db");
  let store = new Store(path);
  try {
    store.put("project", { github: "owner/repo" }, "p");
    store.put("task", { projectId: "p", status: "awaiting_human" }, "t");
    store.put("run", { projectId: "p", taskId: "t", role: "implementation", status: "completed" }, "r");
    let engine = new Engine(store, { close() {} } as unknown as Runtime, dir);
    await engine.document("p", "Result", "Merged outcome", ["source-a"], "r");
    await engine.recordRunEvidence("t", { prEvidence: {
      url: "https://github.com/owner/repo/pull/1", headSha: "reviewed-sha", status: "awaiting_human",
    } });
    store.put("gate", { projectId: "p", taskId: "t", type: "pr", status: "open",
      pr: "https://github.com/owner/repo/pull/1", sha: "reviewed-sha" }, "g");
    const rawPath = join(dir, "wiki", "p", "raw", "r.json");
    const raw = await readFile(rawPath);
    engine.github = async (args: string[]) => args[0] === "pr"
      ? JSON.stringify({ number: 1, url: "https://github.com/owner/repo/pull/1",
        headRefOid: "reviewed-sha", statusCheckRollup: [], mergeable: "MERGEABLE", state: "OPEN" })
      : JSON.stringify({ merged: true, sha: "merged-sha" });
    await engine.approve("g", "reviewed-sha");
    assert.equal(store.get("wiki-ingest:r").pendingEvidence.prEvidence.status, "merged");
    store.close();
    store = new Store(path);
    engine = new Engine(store, { close() {} } as unknown as Runtime, dir);
    await engine.recoverWiki();
    const gate = store.get("g");
    assert.equal(gate.status, "approved");
    assert.equal(gate.reviewedSha, "reviewed-sha");
    assert.equal(gate.mergedSha, "merged-sha");
    assert.equal(store.all("approval", "p").length, 1);
    assert.equal(store.all("approval", "p")[0].reviewedSha, "reviewed-sha");
    assert.equal(store.get("memory:r").prEvidence.status, "merged");
    assert.equal(store.get("memory:r").prEvidence.mergedSha, "merged-sha");
    const folder = join(dir, "wiki", "p");
    assert.match(await readFile(join(folder, "memory:r.md"), "utf8"), /PR outcome.*merged; head reviewed-sha; merged merged-sha/);
    assert.deepEqual(await readFile(rawPath), raw);
    assert.equal((await readFile(join(folder, "index.md"), "utf8")).match(/memory:r.md/g)?.length, 1);
    assert.equal((await readFile(join(folder, "log.md"), "utf8")).match(/; page memory:r\./g)?.length, 1);
    assert.equal(store.search("p", "Merged").length, 1);
    assert.equal(store.search("other", "Merged").length, 0);
    const intent = store.get("wiki-ingest:r");
    store.patch(intent.id, { pendingEvidence: { ...intent.pendingEvidence,
      prEvidence: { ...intent.pendingEvidence.prEvidence, status: "awaiting_human" } } });
    await engine.recoverWiki();
    assert.equal(store.get("wiki-ingest:r").pendingEvidence.prEvidence.status, "merged");
    assert.equal(store.get("memory:r").prEvidence.status, "merged");
    assert.match(await readFile(join(folder, "memory:r.md"), "utf8"), /PR outcome.*merged; head reviewed-sha/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});

test("completion and ingestion intent are one transaction", async () => {
  const dir = await testFixture("looproom-completion-");
  const path = join(dir, "db");
  let store = new Store(path);
  let engine = new Engine(store, { close() {} } as unknown as Runtime, dir);
  try {
    store.put("run", { projectId: "p", status: "running", output: "" }, "r");
    assert.throws(() => store.transaction(() => {
      store.patch("r", { status: "completed", output: "result" });
      throw new Error("crash before intent");
    }), /crash before intent/);
    assert.equal(store.get("r").status, "running");
    assert.equal(store.all("wiki-ingest").length, 0);
    store.transaction(() => {
      store.patch("r", { status: "completed", output: "result" });
      engine.prepareWikiIntent("p", "Result", "Recovered", ["source-a"], "r");
    });
    store.close();
    store = new Store(path);
    engine = new Engine(store, { close() {} } as unknown as Runtime, dir);
    await engine.recoverWiki();
    assert.equal(store.get("r").status, "completed");
    assert.equal(store.search("p", "Recovered").length, 1);
    assert.equal(store.all("memory", "p").length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});

for (const stage of ["raw", "page"]) test("a wiki write failure after durable completion replays without a decision gate: " + stage, async () => {
  const dir = await testFixture("looproom-completed-wiki-");
  const path = join(dir, "db");
  let store = new Store(path);
  store.put("settings", { subagent: { model: "fixture", effort: "medium" } }, "settings");
  const project = store.put("project", { status: "running", path: dir }, "p");
  const task = store.put("task", { projectId: "p", worktree: dir }, "t");
  const runtime = { run: async () => JSON.stringify({ summary: "Durable outcome", sources: ["source-a"] }), close() {} } as unknown as Runtime;
  let engine = new Engine(store, runtime, dir);
  try {
    engine.wikiFailureStage = stage;
    const result = await engine.run(project, "implementation", "fixture", z.object({ summary: z.string(), sources: z.array(z.string()) }), task);
    assert.equal(result.summary, "Durable outcome");
    assert.equal(store.all("run", "p")[0].status, "completed");
    assert.equal(store.all("gate", "p").length, 0);
    assert.match(store.all("wiki-ingest", "p")[0].replayError, /Injected wiki failure/);
    const reportId = randomUUID();
    await engine.recordRunEvidence("t", { checkEvidence: { reportId, sourceHash: "fixture", results: [{ code: 0 }], sourceUnchanged: true } });
    store.close();
    store = new Store(path);
    store.recover();
    engine = new Engine(store, runtime, dir);
    await engine.recoverWiki();
    assert.equal(store.all("gate", "p").length, 0);
    assert.equal(store.all("wiki-ingest", "p")[0].replayError, null);
    assert.equal(store.search("p", "Durable").length, 1);
    const folder = join(dir, "wiki", "p");
    const runId = store.all("run", "p")[0].id;
    const page = await readFile(join(folder, "memory:" + runId + ".md"), "utf8");
    assert.match(page, /Durable outcome/);
    assert.match(page, new RegExp(reportId));
    assert.deepEqual(store.get("memory:" + runId).checkEvidenceHistory.map((report: any) => report.reportId), [reportId]);
    assert.equal((await readFile(join(folder, "index.md"), "utf8")).match(/memory:.*\.md/g)?.length, 1);
    assert.equal((await readFile(join(folder, "log.md"), "utf8")).match(/; page memory:/g)?.length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});

test("check and PR evidence stay with the originating run", async () => {
  const dir = await testFixture("looproom-run-evidence-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, { close() {} } as unknown as Runtime, dir);
  try {
    store.put("task", { projectId: "p" }, "t");
    for (const id of ["a", "b"]) {
      store.put("run", { projectId: "p", taskId: "t", role: "implementation", status: "completed" }, id);
      await engine.document("p", id, id, [], id);
      await engine.recordRunEvidence("t", { checkEvidence: { reportId: id } });
    }
    const earlierReport = randomUUID();
    const laterReport = randomUUID();
    await engine.recordRunEvidence("t", { checkEvidence: { reportId: earlierReport, sourceHash: "first", results: [{ code: 1 }], sourceUnchanged: true } });
    await engine.recordRunEvidence("t", { checkEvidence: { reportId: laterReport, sourceHash: "second", results: [{ code: 0 }], sourceUnchanged: true } });
    await engine.recordRunEvidence("t", { checkEvidence: { reportId: laterReport, sourceHash: "second", results: [{ code: 0 }], sourceUnchanged: true } });
    await engine.recordRunEvidence("t", { prEvidence: { url: "https://example.com/pr/2", headSha: "sha-b" } });
    assert.equal(store.get("memory:a").checkEvidence.reportId, "a");
    assert.equal(store.get("memory:a").prEvidence, undefined);
    assert.equal(store.get("memory:b").checkEvidence.reportId, laterReport);
    assert.deepEqual(store.get("memory:b").checkEvidenceHistory.map((report: any) => report.reportId), ["b", earlierReport, laterReport]);
    assert.equal(store.get("memory:b").prEvidence.headSha, "sha-b");
    const page = await readFile(join(dir, "wiki", "p", "memory:b.md"), "utf8");
    assert.match(page, /sha-b/);
    assert.match(page, new RegExp(earlierReport));
    assert.match(page, new RegExp(laterReport));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});

test("checks for a failed implementation retry stay on that run after restart", async () => {
  const dir = await testFixture("looproom-failed-retry-evidence-");
  const path = join(dir, "db");
  let store = new Store(path);
  try {
    store.put("settings", { subagent: { model: "fixture", effort: "medium" } }, "settings");
    const project = store.put("project", { status: "running", path: dir }, "p");
    const task = store.put("task", { projectId: "p", worktree: dir }, "t");
    store.put("run", { projectId: "p", taskId: "t", role: "implementation", status: "completed", output: "A" }, "a");
    let engine = new Engine(store, { run: async () => { throw new Error("retry failed"); }, close() {} } as unknown as Runtime, dir);
    await engine.document("p", "Run A", "Earlier outcome", ["source-a"], "a");
    const pagePath = join(dir, "wiki", "p", "memory:a.md");
    const before = { page: await readFile(pagePath, "utf8"), pageStat: await stat(pagePath),
      intent: store.get("wiki-ingest:a") };
    await assert.rejects(engine.run(project, "implementation", "retry", z.object({ summary: z.string() }), task, true), /retry failed/);
    const retryId = store.get("t").implementationRunId;
    assert.equal(store.get(retryId).status, "failed");
    engine.verificationRunner = async (options) => ({ id: "retry-report", runId: options.runId, sourceHash: "retry-source",
      sourceUnchanged: true, reportPath: "fixture", createdAt: "2026-01-02T00:00:00.000Z",
      results: [{ command: "test -f result.txt", code: 1, output: "failed", timedOut: false, durationMs: 1 }] });
    await engine.verify(project, task, ["test -f result.txt"], false, retryId);
    assert.equal(JSON.parse(await readFile(join(dir, ".looproom-verification", "retry-report.json"), "utf8")).runId, retryId);
    await engine.recordRunEvidence("t", { checkEvidence: store.get(retryId).checkEvidence }, retryId);
    assert.equal(store.get(retryId).checkEvidence.reportId, "retry-report");
    assert.deepEqual(store.get(retryId).checkEvidenceHistory.map((item: any) => item.reportId), ["retry-report"]);
    assert.equal(store.get("memory:a").checkEvidence, undefined);
    assert.deepEqual(store.get("wiki-ingest:a"), before.intent);
    assert.equal(await readFile(pagePath, "utf8"), before.page);
    assert.equal((await stat(pagePath)).ino, before.pageStat.ino);
    store.close();
    store = new Store(path);
    engine = new Engine(store, { close() {} } as unknown as Runtime, dir);
    await engine.recoverWiki();
    assert.equal(store.get(retryId).checkEvidence.reportId, "retry-report");
    assert.equal(store.get("t").verification.id, "retry-report");
    assert.equal(store.get("memory:a").checkEvidence, undefined);
    assert.deepEqual(store.get("wiki-ingest:a"), before.intent);
    assert.equal(await readFile(pagePath, "utf8"), before.page);
    assert.equal((await stat(pagePath)).ino, before.pageStat.ino);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});

test("replay refuses changed historical raw evidence", async () => {
  const dir = await testFixture("looproom-raw-hash-");
  const store = new Store(join(dir, "db"));
  const engine = new Engine(store, { close() {} } as unknown as Runtime, dir);
  try {
    store.put("run", { projectId: "p", status: "completed" }, "r");
    await engine.document("p", "Result", "Observed.", ["source-a"], "r");
    const rawPath = join(dir, "wiki", "p", "raw", "r.json");
    await writeFile(rawPath, "changed");
    await assert.rejects(engine.recoverWiki(), /Existing raw capture differs/);
    assert.equal(await readFile(rawPath, "utf8"), "changed");
    assert.equal(store.all("memory", "p").length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});


test("reconciled remote merge repairs exact run evidence after a derived-write crash without approval", async () => {
  const dir = await testFixture("looproom-reconciled-wiki-");
  const path = join(dir, "db");
  let store = new Store(path);
  const runtime = { close() {} } as unknown as Runtime;
  try {
    store.put("project", { github: "owner/repo" }, "p");
    store.put("task", { projectId: "p", status: "awaiting_human" }, "t");
    let engine = new Engine(store, runtime, dir);
    const pr = "https://github.com/owner/repo/pull/1";
    const head = "a".repeat(40), mergedSha = "b".repeat(40);
    for (const [id, sha] of [["origin", head], ["newer", "c".repeat(40)]]) {
      store.put("run", { projectId: "p", taskId: "t", role: "implementation", status: "completed" }, id);
      await engine.document("p", id, "Outcome " + id, ["source-a"], id);
      await engine.recordRunEvidence("t", { prEvidence: { url: pr, headSha: sha, status: "awaiting_human" } }, id);
    }
    const rawPath = join(dir, "wiki", "p", "raw", "origin.json");
    const raw = await readFile(rawPath);
    store.put("gate", { projectId: "p", taskId: "t", type: "pr", status: "merging", pr,
      sha: head, mergeAttempt: { pr, number: 1, reviewedSha: head, requestedAt: "attempt" } }, "g");
    let writes = 0;
    engine.mergeBroker = async (args: string[]) => {
      if (args[0] !== "pr") { writes++; throw new Error("Unexpected merge write"); }
      return JSON.stringify({ number: 1, url: pr, state: "MERGED", headRefOid: head, mergeCommit: { oid: mergedSha } });
    };
    engine.writeIfChanged = async () => { throw new Error("Derived write interrupted"); };
    await assert.rejects(engine.reconcileMerge("g"), /Derived write interrupted/);
    assert.equal(store.get("g").status, "reconciled");
    assert.equal(store.get("t").status, "completed");
    // Simulate evidence writes lost before replay; the remote fact remains durable.
    for (const id of ["origin", "memory:origin"]) store.patch(id, { prEvidence: { url: pr, headSha: head, status: "awaiting_human" } });
    store.patch("wiki-ingest:origin", { pendingEvidence: { prEvidence: { url: pr, headSha: head, status: "awaiting_human" } } });
    store.close(); store = new Store(path);
    engine = new Engine(store, runtime, dir);
    await engine.recoverWiki();
    await engine.recoverWiki();
    for (const id of ["origin", "memory:origin"]) {
      assert.equal(store.get(id).prEvidence.status, "merged");
      assert.equal(store.get(id).prEvidence.mergedSha, mergedSha);
      assert.equal(store.get(id).prEvidence.mergeActor, "unverified");
    }
    assert.equal(store.get("wiki-ingest:origin").pendingEvidence.prEvidence.status, "merged");
    for (const id of ["newer", "memory:newer"]) assert.equal(store.get(id).prEvidence.status, "awaiting_human");
    assert.equal(store.get("wiki-ingest:newer").pendingEvidence.prEvidence.status, "awaiting_human");
    assert.match(await readFile(join(dir, "wiki", "p", "memory:origin.md"), "utf8"), /merge actor unverified/);
    assert.deepEqual(await readFile(rawPath), raw);
    assert.equal(store.all("approval").length, 0);
    assert.equal(writes, 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }).catch((error) => { if (error.code !== "EPERM") throw error; }); }
});
