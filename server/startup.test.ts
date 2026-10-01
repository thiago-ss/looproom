import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { Store } from "./store.ts";
import { testFixture } from "./test-fixtures.ts";
import { stopChild, waitForChildExit } from "./child-test.ts";

test("one data directory permits one coordinator across ports and releases ownership on exit", async () => {
  const dir = await testFixture("looproom-startup-");
  const actualDataDir = join(dir, "data");
  const dataDir = join(dir, "linked-data");
  await mkdir(actualDataDir);
  await symlink(actualDataDir, dataDir);
  const db = join(dataDir, "looproom.sqlite");
  const store = new Store(db);
  store.put("project", { status: "running" }, "project");
  store.put("task", { projectId: "project", status: "running", worktree: "/preserved/worktree" }, "task");
  store.put("run", { projectId: "project", taskId: "task", status: "running" }, "run");
  store.close();
  const binary = join(dir, "codex.mjs");
  await writeFile(binary, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!=null)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[]}:{account:null}})+'\\n');});`, { mode: 0o755 });
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const otherPort = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const children: { child: ChildProcess; output: () => string }[] = [];
  try {
    const start = (selectedPort: number) => {
      const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
        env: { ...process.env, PORT: String(selectedPort), LOOPROOM_DATA_DIR: dataDir, CODEX_BINARY: binary },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => { output += chunk; });
      child.stderr?.on("data", (chunk) => { output += chunk; });
      const entry = { child, output: () => output };
      children.push(entry);
      return entry;
    };
    const first = start(port);
    const second = start(otherPort);
    const loser = await Promise.race([first, second].map(async (entry) => {
      const code = await waitForChildExit(entry.child, entry.output);
      return { entry, code };
    }));
    assert.notEqual(loser.code, 0);
    assert.match(loser.entry.output(), /Another Looproom coordinator owns/);
    const winner = loser.entry === first ? second : first;
    const winnerPort = winner === first ? port : otherPort;
    const deadline = Date.now() + 10000;
    let health: any;
    while (Date.now() < deadline) {
      health = await fetch(`http://127.0.0.1:${winnerPort}/api/health`).then((r) => r.json()).catch(() => null);
      if (health?.status === "ok") break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(health?.status, "ok", winner.output());
    assert.equal(health?.dataDir, await realpath(actualDataDir));
    const recovered = new Store(db);
    try {
      assert.equal(recovered.get("task").worktree, "/preserved/worktree");
      assert.equal(recovered.all("gate", "project").filter((gate) => gate.type === "interrupted").length, 1);
    } finally { recovered.close(); }
    await stopChild(winner.child, winner.output);
    const restarted = start(loser.entry === first ? port : otherPort);
    const restartPort = loser.entry === first ? port : otherPort;
    let restartedHealth: any;
    while (Date.now() < deadline + 10000) {
      restartedHealth = await fetch(`http://127.0.0.1:${restartPort}/api/health`).then((r) => r.json()).catch(() => null);
      if (restartedHealth?.status === "ok") break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(restartedHealth?.status, "ok", restarted.output());
    const afterRestart = new Store(db);
    try { assert.equal(afterRestart.all("gate", "project").filter((gate) => gate.type === "interrupted").length, 1); }
    finally { afterRestart.close(); }
  } finally {
    await Promise.all(children.map((entry) => stopChild(entry.child, entry.output)));
    await rm(dir, { recursive: true, force: true });
  }
});
