import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRepo } from "./git.ts";
import { testFixture } from "./test-fixtures.ts";

test("local API requires a session, rejects foreign origins and keeps projects after restart", async () => {
  const dir = await testFixture("looproom-api-");
  const binary = join(dir, "fixture.mjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
 import {createInterface} from 'node:readline';
 createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;let result={};if(m.method==='account/read')result={account:null};if(m.method==='model/list')result={data:[]};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`,
    { mode: 0o755 },
  );
  let child: ReturnType<typeof spawn>;
  async function start() {
    child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      env: {
        ...process.env,
        PORT: "0",
        LOOPROOM_DATA_DIR: join(dir, "data"),
        CODEX_BINARY: binary,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Server did not start")),
        10000,
      );
      child.stdout!.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/coordinator: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Server exited: " + output));
      });
    });
  }
  async function stop() {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
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
    assert.equal((await response.json()).status, "paused");
    await stop();
    url = await start();
    response = await fetch(url + "/api/state");
    const state = await response.json();
    assert.equal(state.projects[0].name, "API project");
    assert.equal(state.messages[0].text, body.goal);
    assert.equal(state.settings.orchestrator.model, "gpt-6.1-sol");
    assert.equal(state.settings.subagent.effort, "medium");
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
