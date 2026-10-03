import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRepo } from "./git.ts";
import { Store } from "./store.ts";
import { testFixture } from "./test-fixtures.ts";
import { stopChild } from "./child-test.ts";

test("local API requires a session, rejects foreign origins and keeps projects after restart", async () => {
  const dir = await testFixture("looproom-api-");
  const binary = join(dir, "fixture.mjs");
  const githubFixture = join(dir, "gh");
  await writeFile(
    binary,
    `#!/usr/bin/env node
 import {createInterface} from 'node:readline';
 createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;let result={};if(m.method==='account/read')result={account:null};if(m.method==='model/list')result={data:[]};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`,
    { mode: 0o755 },
  );
  await writeFile(githubFixture,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({number:1,url:'https://github.com/example/fixture/pull/1',baseRefName:'main',state:'OPEN',headRefOid:'${"a".repeat(40)}',statusCheckRollup:[],mergeable:'MERGEABLE'})+'\\n');`,
    { mode: 0o755 });
  let child: ReturnType<typeof spawn>;
  let childOutput = "";
  async function start() {
    childOutput = "";
    child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      env: {
        ...process.env,
        PORT: "0",
        LOOPROOM_DATA_DIR: join(dir, "data"),
        CODEX_BINARY: binary,
        PATH: dir + ":" + process.env.PATH,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk) => { childOutput += chunk; });
    return new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Server did not start: " + childOutput)),
        10000,
      );
      child.stdout!.on("data", (chunk) => {
        output += chunk;
        childOutput += chunk;
        const match = output.match(/coordinator: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Server exited: " + childOutput));
      });
    });
  }
  async function stop() {
    await stopChild(child, () => childOutput);
  }
  try {
    let url = await start();
    const repo = await createRepo(join(dir, "repo"));
    const body = {
      mode: "existing",
      path: repo.path,
      name: "API project",
      goal: "Build useful work",
      constraints: "Human merge approval",
      checks: ["npm test"],
    };
    let response = await fetch(url + "/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-looproom-client": "ui",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403);
    response = await fetch(url + "/api/state");
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await response.json()).projects.length, 0);
    response = await fetch(url + "/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-looproom-client": "ui",
        cookie,
        origin: "https://unrelated.example",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403);
    response = await fetch(url + "/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-looproom-client": "ui",
        cookie,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const created = await response.json();
    assert.equal(created.status, "paused");
    response = await fetch(url + "/api/state");
    assert.deepEqual((await response.json()).events, []);
    response = await fetch(url + "/api/state?events=1");
    assert.ok((await response.json()).events.length > 0);
    response = await fetch(url + "/api/state");
    assert.deepEqual((await response.json()).events, []);
    const fixtureStore = new Store(join(dir, "data", "looproom.sqlite"));
    const task = fixtureStore.put("task", {
      projectId: created.id, status: "awaiting_human", dependencies: [],
      title: "Review fixture",
    });
    const prGate = fixtureStore.put("gate", {
      projectId: created.id, taskId: task.id, type: "pr", status: "open",
      title: "Review pull request", pr: "https://github.com/example/fixture/pull/1",
      sha: "a".repeat(40),
    });
    fixtureStore.put("gate", {
      projectId: created.id, type: "decision", status: "open", scope: "project",
      title: "Hold fixture dispatch", judgeStatus: "answered",
    });
    fixtureStore.close();
    const settingHeaders = {
      "content-type": "application/json",
      "x-looproom-client": "ui",
      cookie,
    };
    for (const [path, payload] of [
      ["/api/projects/settings/control", { action: "pause" }],
      ["/api/projects/settings/messages", { text: "Cross-kind mutation" }],
      ["/api/projects/settings/settings", {
        checks: [], constraints: "Cross-kind mutation", escalationMode: "yolo",
      }],
      ["/api/gates/" + task.id + "/judge", {}],
    ] as const) {
      const wrongKind = await fetch(url + path, {
        method: "POST", headers: settingHeaders, body: JSON.stringify(payload),
      });
      assert.equal(wrongKind.status, 409, path);
    }
    const afterWrongKind = new Store(join(dir, "data", "looproom.sqlite"));
    assert.equal(afterWrongKind.get("settings").status, undefined);
    assert.equal(afterWrongKind.get("settings").constraints, undefined);
    assert.equal(afterWrongKind.all("message", "settings").length, 0);
    assert.equal(afterWrongKind.get(task.id).judgeStatus, undefined);
    afterWrongKind.close();
    response = await fetch(url + "/api/gates/" + prGate.id + "/resolve", {
      method: "POST", headers: settingHeaders,
      body: JSON.stringify({ answer: "Proceed", retry: true }),
    });
    assert.equal(response.status, 409);
    const afterRejectedResolve = new Store(join(dir, "data", "looproom.sqlite"));
    assert.equal(afterRejectedResolve.get(prGate.id).status, "open");
    assert.equal(afterRejectedResolve.get(task.id).status, "awaiting_human");
    assert.equal(afterRejectedResolve.all("approval", created.id).length, 0);
    afterRejectedResolve.close();
    response = await fetch(url + "/api/gates/" + prGate.id + "/changes", {
      method: "POST", headers: settingHeaders,
      body: JSON.stringify({ sha: "b".repeat(40), answer: "Add a regression test" }),
    });
    assert.equal(response.status, 409);
    response = await fetch(url + "/api/gates/" + prGate.id + "/changes", {
      method: "POST", headers: settingHeaders,
      body: JSON.stringify({ sha: "a".repeat(40), answer: "Add a regression test" }),
    });
    assert.equal(response.status, 200);
    const afterChanges = new Store(join(dir, "data", "looproom.sqlite"));
    assert.equal(afterChanges.get(prGate.id).status, "resolved");
    assert.equal(afterChanges.get(task.id).status, "ready");
    assert.match(afterChanges.get(task.id).feedback, /Add a regression test/);
    assert.equal(afterChanges.all("approval", created.id).length, 0);
    afterChanges.close();
    response = await fetch(url + "/api/projects/" + created.id + "/settings", {
      method: "POST",
      headers: settingHeaders,
      body: JSON.stringify({
        checks: body.checks,
        constraints: body.constraints,
        escalationMode: "yolo",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).escalationMode, "yolo");
    response = await fetch(url + "/api/projects/" + created.id + "/settings", {
      method: "POST",
      headers: settingHeaders,
      body: JSON.stringify({
        checks: body.checks,
        constraints: body.constraints,
        escalationMode: "invented",
      }),
    });
    assert.equal(response.status, 400);
    response = await fetch(url + "/api/projects/" + created.id + "/control", {
      method: "POST", headers: settingHeaders,
      body: JSON.stringify({ action: "pause" }),
    });
    assert.equal(response.status, 200);
    await stop();
    url = await start();
    response = await fetch(url + "/api/state");
    const state = await response.json();
    assert.equal(state.projects[0].name, "API project");
    assert.equal(state.projects[0].escalationMode, "yolo");
    assert.ok(state.messages.some((message: { text?: string }) => message.text === body.goal));
    assert.equal(state.settings.orchestrator.model, "gpt-6.1-sol");
    assert.equal(state.settings.subagent.effort, "medium");
    await stop();
    const interrupted = new Store(join(dir, "data", "looproom.sqlite"));
    interrupted.patch(created.id, { status: "running" });
    interrupted.put("task", { projectId: created.id, status: "running", worktree: "/preserved/worktree" }, "interrupted-task");
    interrupted.close();
    url = await start();
    response = await fetch(url + "/api/state");
    const recoveryCookie = response.headers.get("set-cookie")!.split(";")[0];
    const recovered = await response.json();
    assert.equal(recovered.projects[0].status, "paused");
    assert.equal(recovered.gates.filter((gate: any) => gate.type === "interrupted").length, 1);
    response = await fetch(url + "/api/projects/" + created.id + "/control", {
      method: "POST",
      headers: { ...settingHeaders, cookie: recoveryCookie },
      body: JSON.stringify({ action: "start" }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /resolve the interrupted work/);
    response = await fetch(url + "/api/state");
    assert.equal((await response.json()).projects[0].status, "paused");
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
