import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { connect } from "node:net";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./store.ts";
import { testFixture } from "./test-fixtures.ts";
import { captureBrowserSnapshot, loadBrowserSnapshot, startBrowserViewer } from "./browser-snapshot.ts";

test("freezes only revision-matched selected-project PR review and never forwards viewer reads", async () => {
  const dir = await testFixture("browser-pr-review-");
  const databasePath = join(dir, "live.sqlite"), directory = join(dir, "snapshots"), dist = join(dir, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Review</title>");
  const store = new Store(databasePath);
  try {
    const project = store.put("project", { name: "Review goal", github: "example/project", branch: "main" });
    const other = store.put("project", { name: "Other", github: "example/other", branch: "main" });
    const sha = "a".repeat(40), pr = "https://github.com/example/project/pull/9";
    const gate = store.put("gate", { projectId: project.id, type: "pr", status: "open", pr, sha });
    const foreign = store.put("gate", { projectId: project.id, type: "pr", status: "open", pr: "https://github.com/example/private/pull/5", sha });
    const wrongBase = store.put("gate", { projectId: project.id, type: "pr", status: "open", pr: "https://github.com/example/project/pull/6", sha, base: "release" });
    store.put("gate", { projectId: other.id, type: "pr", status: "open", pr: "https://github.com/example/other/pull/4", sha: "b".repeat(40) });
    let calls = 0;
    const snapshot = await captureBrowserSnapshot({ databasePath, projectId: project.id, directory, capturePrReview: async binding => {
      calls++;
      assert.deepEqual(binding, { gateId: gate.id, projectId: project.id, pr, sha, base: "main" });
      return { info: { number: 9, url: pr, headRefOid: sha, baseRefName: "main", baseRefOid: "b".repeat(40), state: "OPEN", title: "Actual PR" }, diff: "diff --git a/a b/a\n+actual change\n" };
    } });
    assert.equal(calls, 1);
    assert.equal(snapshot.review?.[gate.id].info.title, "Actual PR");
    assert.equal(snapshot.review?.[foreign.id], undefined);
    assert.equal(snapshot.review?.[wrongBase.id], undefined);
    assert.deepEqual(await loadBrowserSnapshot(directory, snapshot.id, project.id), snapshot);
    store.patch(gate.id, { sha: "c".repeat(40) });
    const viewer = await startBrowserViewer({ snapshot, distDir: dist });
    try {
      const base = new URL(viewer.url).origin;
      const entry = await fetch(viewer.url, { redirect: "manual" });
      const cookie = entry.headers.get("set-cookie")!.split(";")[0];
      const get = (path: string) => fetch(base + path, { headers: { cookie } });
      assert.equal((await fetch(base + `/api/gates/${gate.id}/pr`)).status, 403);
      const info = await get(`/api/gates/${gate.id}/pr`);
      assert.equal(info.status, 200);
      assert.equal(info.headers.get("cache-control"), "no-store");
      assert.equal((await info.json()).headRefOid, sha);
      assert.deepEqual(await (await get(`/api/gates/${gate.id}/diff`)).json(), { diff: "diff --git a/a b/a\n+actual change\n" });
      assert.equal((await get("/api/gates/unknown/pr")).status, 404);
      assert.equal((await get("/api/gates/unknown/diff")).status, 404);
      assert.equal((await get(`/api/gates/${foreign.id}/pr`)).status, 404);
      assert.equal((await get(`/api/gates/${wrongBase.id}/diff`)).status, 404);
      assert.equal((await fetch(base + `/api/gates/${gate.id}/pr`, { method: "POST", headers: { cookie } })).status, 405);
      assert.equal(calls, 1, "viewer must use frozen bytes, never call the capture source");
    } finally { await viewer.close(); }
    const largeDiff = "diff --git a/x b/x\n" + "+x\n".repeat(500_000);
    const large = await captureBrowserSnapshot({ databasePath, projectId: project.id, directory,
      capturePrReview: async () => ({ info: { number: 9, url: pr, headRefOid: "c".repeat(40), baseRefName: "main", baseRefOid: "b".repeat(40), state: "OPEN" }, diff: largeDiff }) });
    assert.equal(large.review?.[gate.id].diff, largeDiff, "valid diff above one MiB must remain available");
    assert.equal((await loadBrowserSnapshot(directory, large.id, project.id)).review?.[gate.id].diff.length, largeDiff.length);
    const largeViewer = await startBrowserViewer({ snapshot: large, distDir: dist });
    try {
      const entry = await fetch(largeViewer.url, { redirect: "manual" });
      const cookie = entry.headers.get("set-cookie")!.split(";")[0];
      const response = await fetch(new URL(largeViewer.url).origin + `/api/gates/${gate.id}/diff`, { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).diff, largeDiff);
    } finally { await largeViewer.close(); }
    const invalid = async (change: Record<string, unknown>) => {
      const unavailable = await captureBrowserSnapshot({ databasePath, projectId: project.id, directory,
        capturePrReview: async () => ({ info: { number: 9, state: "OPEN", baseRefOid: "b".repeat(40), url: pr, headRefOid: "c".repeat(40), baseRefName: "main", ...change }, diff: "diff" }) });
      assert.equal(unavailable.review?.[gate.id], undefined, "mismatched revision must never be frozen");
      assert.equal(unavailable.state.gates.find((item: any) => item.id === gate.id)?.sha, "c".repeat(40));
    };
    await invalid({ url: "https://github.com/example/other/pull/4" });
    await invalid({ headRefOid: sha });
    await invalid({ baseRefName: "other" });
    await invalid({ number: 8 });
    await invalid({ state: "CLOSED" });
    const missingDiff = await captureBrowserSnapshot({ databasePath, projectId: project.id, directory,
      capturePrReview: async () => ({ info: { number: 9, state: "OPEN", baseRefOid: "b".repeat(40), url: pr, headRefOid: "c".repeat(40), baseRefName: "main" }, diff: "" }) });
    assert.equal(missingDiff.review?.[gate.id], undefined);
    const oversized = await captureBrowserSnapshot({ databasePath, projectId: project.id, directory,
      capturePrReview: async () => ({ info: { number: 9, state: "OPEN", baseRefOid: "b".repeat(40), url: pr, headRefOid: "c".repeat(40), baseRefName: "main" }, diff: "x".repeat(2_000_001) }) });
    assert.equal(oversized.review?.[gate.id], undefined);
    const file = join(directory, snapshot.id + ".json");
    const tampered = JSON.parse(await readFile(file, "utf8"));
    tampered.review[gate.id].sha = "c".repeat(40);
    const { hash: _oldHash, ...body } = tampered;
    tampered.hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    await chmod(file, 0o600);
    await writeFile(file, JSON.stringify(tampered));
    await assert.rejects(() => loadBrowserSnapshot(directory, snapshot.id, project.id), /PR review does not match/);
  } finally { store.close(); }
});

test("imported PR snapshot binds the gate's exact base commit while native gates keep their schema", async () => {
  const dir = await testFixture("browser-imported-pr-base-");
  const databasePath = join(dir, "live.sqlite"), directory = join(dir, "snapshots");
  const store = new Store(databasePath);
  try {
    const project = store.put("project", { github: "example/project", branch: "main" });
    const sha = "a".repeat(40), baseSha = "b".repeat(40);
    const pr = "https://github.com/example/project/pull/10";
    const gate = store.put("gate", { projectId: project.id, type: "pr", status: "open",
      importedFromGitHub: true, pr, sha, base: "main", baseSha });
    const capture = (remoteBase: string) => captureBrowserSnapshot({ databasePath, projectId: project.id,
      directory, capturePrReview: async binding => {
        assert.deepEqual(binding, { gateId: gate.id, projectId: project.id, pr, sha, base: "main", baseSha });
        return { info: { number: 10, url: pr, headRefOid: sha, baseRefName: "main",
          baseRefOid: remoteBase, state: "OPEN" }, diff: "diff --git a/a b/a\n+external change\n" };
      } });
    const advancedBase = await capture("c".repeat(40));
    assert.equal(advancedBase.review?.[gate.id], undefined,
      "an imported gate must not freeze a newer base revision at the same head");
    const matched = await capture(baseSha);
    assert.equal(matched.review?.[gate.id].baseSha, baseSha);
    assert.deepEqual(await loadBrowserSnapshot(directory, matched.id, project.id), matched);
    const file = join(directory, matched.id + ".json");
    const tampered = JSON.parse(await readFile(file, "utf8"));
    tampered.review[gate.id].info.baseRefOid = "c".repeat(40);
    const { hash: _hash, ...body } = tampered;
    tampered.hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    await chmod(file, 0o600);
    await writeFile(file, JSON.stringify(tampered));
    await assert.rejects(() => loadBrowserSnapshot(directory, matched.id, project.id), /PR review does not match/);
  } finally { store.close(); }
});

test("one PR read failure leaves other actual project records and bound PR review available", async () => {
  const dir = await testFixture("browser-pr-read-failure-");
  const databasePath = join(dir, "live.sqlite"), directory = join(dir, "snapshots"), dist = join(dir, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Review</title>");
  const store = new Store(databasePath);
  try {
    const project = store.put("project", { name: "Selected goal", github: "example/project", branch: "main" });
    const task = store.put("task", { projectId: project.id, title: "Preserved work", status: "running", dependencies: [] });
    store.put("message", { projectId: project.id, text: "Preserved conversation", createdAt: "2026-10-03T00:00:00Z" });
    const memory = store.memory(project.id, "Preserved outcome", "Cited project result", ["source-a"]);
    const sha = "a".repeat(40), baseRefOid = "b".repeat(40);
    const failed = store.put("gate", { projectId: project.id, taskId: task.id, type: "pr", status: "open", pr: "https://github.com/example/project/pull/9", sha });
    const available = store.put("gate", { projectId: project.id, taskId: task.id, type: "pr", status: "open", pr: "https://github.com/example/project/pull/10", sha });
    const snapshot = await captureBrowserSnapshot({ databasePath, projectId: project.id, directory, capturePrReview: async binding => {
      if (binding.gateId === failed.id) throw new Error("private credential-bearing read failure");
      return { info: { number: 10, url: available.pr, headRefOid: sha, baseRefName: "main", baseRefOid, state: "OPEN" }, diff: "diff --git a/x b/x\n+one change\n" };
    } });
    assert.equal(snapshot.review?.[failed.id], undefined);
    assert.equal(snapshot.review?.[available.id].info.number, 10);
    assert.equal(snapshot.state.tasks[0].id, task.id);
    assert.equal(snapshot.state.messages[0].text, "Preserved conversation");
    assert.equal(snapshot.state.memory[0].id, memory.id);
    assert.equal(snapshot.state.gates.length, 2);
    assert.ok(!JSON.stringify(snapshot).includes("private credential-bearing"));
    assert.deepEqual(await loadBrowserSnapshot(directory, snapshot.id, project.id), snapshot);
    const viewer = await startBrowserViewer({ snapshot, distDir: dist });
    try {
      const entry = await fetch(viewer.url, { redirect: "manual" });
      const cookie = entry.headers.get("set-cookie")!.split(";")[0];
      const base = new URL(viewer.url).origin;
      const get = (path: string) => fetch(base + path, { headers: { cookie } });
      assert.equal((await get(`/api/gates/${failed.id}/pr`)).status, 404);
      assert.equal((await get(`/api/gates/${available.id}/pr`)).status, 200);
      assert.equal((await get("/api/state")).status, 200);
    } finally { await viewer.close(); }
  } finally { store.close(); }
});

test("captures one actual WAL project and serves only immutable read-only state", async () => {
  const dir = await testFixture("browser-snapshot-");
  const databasePath = join(dir, "live.sqlite");
  const snapshots = join(dir, "snapshots");
  const dist = join(dir, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Audited app</title>");
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "assets", "app-123.js"), "export const app = true;");
  const store = new Store(databasePath);
  try {
    const project = store.put("project", { name: "Real goal", goal: "Ship this app", path: join(dir, "repo") });
    const other = store.put("project", { name: "Other" });
    store.put("settings", { orchestrator: { model: "fixture" }, account: { token: "private" } }, "settings");
    store.put("task", { projectId: project.id, title: "Actual task", status: "running" });
    store.put("gate", { projectId: project.id, title: "Actual review", type: "pr", status: "open" });
    store.put("message", { projectId: project.id, text: "Actual user text", role: "human", createdAt: "2026-10-03T00:00:00Z" });
    store.put("run", { projectId: project.id, role: "research", output: "secret raw output", status: "complete" });
    store.memory(project.id, "Alpha evidence", "Goal outcome plum", ["source-a"]);
    store.memory(project.id, "Beta evidence", "Work outcome citron", ["source-b"]);
    store.memory(other.id, "Other evidence", "plum outsider", ["source-c"]);
    store.event("changed", { projectId: project.id }, project.id);
    store.event("changed", { projectId: other.id }, other.id);
    const expectedSearch = store.search(project.id, "plum citron").map((page) => page.id);
    const before = store.db.prepare("SELECT count(*) AS n FROM records").get() as { n: number };
    const snapshot = await captureBrowserSnapshot({ databasePath, projectId: project.id, directory: snapshots });
    assert.equal(snapshot.state.projects[0].goal, "Ship this app");
    assert.equal(snapshot.state.tasks[0].title, "Actual task");
    assert.equal(snapshot.state.gates[0].title, "Actual review");
    assert.equal(snapshot.state.messages[0].text, "Actual user text");
    assert.equal(snapshot.state.memory.length, 2);
    assert.equal(snapshot.counts.memory, 2);
    assert.equal(snapshot.counts.indexedProjects, 2);
    assert.equal(snapshot.counts.indexedMemoryRows, 3);
    assert.equal(snapshot.state.runs[0].output, undefined);
    assert.equal(snapshot.state.settings.account, undefined);
    assert.equal(snapshot.state.events.length, 1);
    assert.equal(snapshot.eventSequence, 1);
    assert.equal((store.db.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n, before.n);
    assert.deepEqual(await loadBrowserSnapshot(snapshots, snapshot.id, project.id), snapshot);
    await assert.rejects(() => loadBrowserSnapshot(snapshots, snapshot.id, other.id), /mismatch/);
    const viewer = await startBrowserViewer({ snapshot, distDir: dist });
    try {
      const base = new URL(viewer.url).origin;
      assert.equal((await fetch(base + "/api/state")).status, 403);
      assert.equal((await fetch(base + "/api/projects/" + project.id + "/memory")).status, 403);
      const entry = await fetch(viewer.url, { redirect: "manual" });
      assert.equal(entry.status, 302);
      assert.equal(entry.headers.get("location"), "/");
      const cookie = entry.headers.get("set-cookie")!.split(";")[0];
      assert.match(cookie, /^audit_snapshot=[0-9a-f]{64}$/);
      assert.equal((await fetch(base + "/api/state", { headers: { cookie: "audit_snapshot=" + "0".repeat(64) } })).status, 403);
      const get = (path: string) => fetch(base + path, { headers: { cookie } });
      const state = await get("/api/state");
      assert.equal(state.status, 200);
      assert.equal(state.headers.get("set-cookie"), null);
      assert.match(state.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
      assert.equal((await state.json()).events.length, 0);
      assert.equal(state.headers.get("cache-control"), "no-store");
      const withEvents = await get("/api/state?events=1");
      assert.equal((await withEvents.json()).events.length, 1);
      const search = await get(`/api/projects/${project.id}/memory?q=plum%20citron`);
      assert.deepEqual((await search.json()).map((page: any) => page.id).sort(), expectedSearch.sort());
      assert.equal((await get(`/api/projects/${other.id}/memory`)).status, 404);
      for (const path of ["/api/projects", `/api/gates/${snapshot.state.gates[0].id}/approve`, "/api/settings"]) {
        const response = await fetch(base + path, { method: "POST", headers: { cookie: cookie + "; looproom_session=forged", "x-looproom-client": "ui" }, body: "{}" });
        assert.equal(response.status, 405);
      }
      assert.equal((await get("/api/unknown")).status, 404);
      assert.equal((await get("/api%2Funknown")).status, 404);
      assert.equal((await get("/api/gates/anything/pr")).status, 404);
      assert.equal((await get("/")).status, 200);
      assert.equal((await get("/assets/app-123.js")).headers.get("cache-control"), "private, max-age=3600, immutable");
      assert.equal((await get("/snapshots/" + snapshot.id + ".json")).status, 404);
      const port = Number(new URL(base).port);
      const localProxyStatus = await new Promise<number>((resolve, reject) => {
        const proxy = request({ host: "127.0.0.1", port, method: "GET", path: base + "/api/state", headers: { host: new URL(base).host, cookie } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        proxy.on("error", reject);
        proxy.end();
      });
      assert.equal(localProxyStatus, 200);
      const foreignStatus = await new Promise<number>((resolve, reject) => {
        const proxy = request({ host: "127.0.0.1", port, method: "GET", path: "http://example.invalid/private", headers: { host: "example.invalid" } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        proxy.on("error", reject);
        proxy.end();
      });
      assert.equal(foreignStatus, 403);
      const tunnelReply = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => socket.write("CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n"));
        let reply = "";
        socket.on("data", (chunk) => { reply += chunk; });
        socket.on("end", () => resolve(reply));
        socket.on("error", reject);
      });
      assert.match(tunnelReply, /^HTTP\/1\.1 403 Forbidden/);
      assert.equal((store.db.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n, before.n);
    } finally { await viewer.close(); }
  } finally { store.close(); }
});

test("snapshot load rejects changed bytes and symlinks", async () => {
  const dir = await testFixture("browser-snapshot-integrity-");
  const databasePath = join(dir, "live.sqlite");
  const store = new Store(databasePath);
  try {
    const project = store.put("project", { name: "Only project" });
    const directory = join(dir, "snapshots");
    const snapshot = await captureBrowserSnapshot({ databasePath, projectId: project.id, directory });
    const file = join(directory, snapshot.id + ".json");
    await symlink(file, join(directory, "00000000-0000-0000-0000-000000000000.json"));
    await assert.rejects(() => loadBrowserSnapshot(directory, "00000000-0000-0000-0000-000000000000", project.id), /real file/);
    const linkedDirectory = join(dir, "linked");
    await symlink(directory, linkedDirectory);
    await assert.rejects(() => loadBrowserSnapshot(linkedDirectory, snapshot.id, project.id), /real directory/);
    const changed = JSON.parse(await readFile(file, "utf8"));
    changed.state.projects[0].name = "tampered";
    await chmod(file, 0o600);
    await writeFile(file, JSON.stringify(changed));
    await assert.rejects(() => loadBrowserSnapshot(directory, snapshot.id, project.id), /hash mismatch/);
  } finally { store.close(); }
});

test("snapshot keeps message and event tables consistent while WAL commits continue", async () => {
  const dir = await testFixture("browser-snapshot-concurrent-");
  const databasePath = join(dir, "live.sqlite");
  const store = new Store(databasePath);
  const project = store.put("project", { name: "Concurrent real records" });
  const source = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(databasePath)}, { timeout: 5000 });
    const projectId = ${JSON.stringify(project.id)};
    process.send('ready');
    (async () => {
      for (let i = 1; i <= 100; i++) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const id = 'message:' + i;
          db.prepare('INSERT INTO records(id,kind,data) VALUES(?,?,?)').run(id, 'message', JSON.stringify({ id, projectId, text: 'Committed ' + i, createdAt: new Date().toISOString() }));
          db.prepare('INSERT INTO events(project_id,type,data,created_at) VALUES(?,?,?,?)').run(projectId, 'message-added', JSON.stringify({ id }), new Date().toISOString());
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      db.close();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let childError = "";
  child.stderr?.on("data", (chunk) => { childError += String(chunk); });
  const completed = new Promise<void>((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Writer exited ${code}: ${childError}`))));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
    });
    let observedPartial = false;
    for (let i = 0; i < 60; i++) {
      const snapshot = await captureBrowserSnapshot({ databasePath, projectId: project.id, directory: join(dir, "snapshots") });
      assert.equal(snapshot.counts.message, snapshot.eventSequence, `mixed record/event commit at capture ${i}`);
      if (snapshot.counts.message > 0 && snapshot.counts.message < 100) observedPartial = true;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await completed;
    assert.equal(observedPartial, true, "test must observe at least one in-progress WAL state");
    const final = await captureBrowserSnapshot({ databasePath, projectId: project.id, directory: join(dir, "snapshots") });
    assert.equal(final.counts.message, 100);
    assert.equal(final.eventSequence, 100);
  } finally {
    if (child.exitCode === null) child.kill();
    store.close();
  }
});
