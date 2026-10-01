import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { testFixture } from "./test-fixtures.ts";
import { stopChild, waitForChildExit } from "./child-test.ts";

test("initial launch reinstalls dependencies before caching a build, then reuses verified assets", async () => {
  const dir = await testFixture("looproom-launch-");
  const oldPath = process.env.PATH;
  try {
    await mkdir(join(dir, "scripts"));
    await mkdir(join(dir, "bin"));
    await mkdir(join(dir, "node_modules", "demo"), { recursive: true });
    await copyFile(join(process.cwd(), "scripts", "launch.mjs"), join(dir, "scripts", "launch.mjs"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module", dependencies: { demo: "1.0.0" } }));
    await writeFile(join(dir, "package-lock.json"), "new-lock");
    await writeFile(join(dir, "tsconfig.json"), "{}");
    await writeFile(join(dir, "vite.config.ts"), "export default {};");
    await writeFile(join(dir, "index.html"), "<main>source</main>");
    await writeFile(join(dir, "node_modules", ".package-lock.json"), "old-lock");
    await writeFile(join(dir, "node_modules", "demo", "package.json"), "{}");
    await writeFile(join(dir, "bin", "npm"), `#!/bin/sh
if [ "$1" = --version ]; then echo 10.0.0; exit 0; fi
echo "$1 $2" >> events.log
if [ "$1" = ci ]; then
  mkdir -p node_modules/demo
  echo new-lock > node_modules/.package-lock.json
  echo '{}' > node_modules/demo/package.json
elif [ "$1" = run ] && [ "$2" = build ]; then
  mkdir -p dist
  cp index.html dist/index.html
fi
`, { mode: 0o755 });
    process.env.PATH = join(dir, "bin") + ":" + oldPath;
    const { ensureBuild } = await import(join(dir, "scripts", "launch.mjs"));
    await ensureBuild();
    assert.deepEqual((await readFile(join(dir, "events.log"), "utf8")).trim().split("\n").map((s) => s.trim()), ["ci", "run build"]);
    const installed = JSON.parse(await readFile(join(dir, "node_modules", ".looproom-install.json"), "utf8"));
    const built = JSON.parse(await readFile(join(dir, "dist", ".looproom-build.json"), "utf8"));
    assert.equal(installed.dependencyHash, built.dependencyHash);
    assert.equal(installed.version, 1);
    assert.match(installed.treeHash, /^[a-f0-9]{64}$/);
    await ensureBuild();
    assert.equal((await readFile(join(dir, "events.log"), "utf8")).trim().split("\n").length, 2);
    await writeFile(join(dir, "node_modules", "demo", "package.json"), '{"tampered":true}');
    await ensureBuild();
    assert.deepEqual((await readFile(join(dir, "events.log"), "utf8")).trim().split("\n").map((s) => s.trim()),
      ["ci", "run build", "ci", "run build"]);
    await ensureBuild();
    assert.equal((await readFile(join(dir, "events.log"), "utf8")).trim().split("\n").length, 4);
    await writeFile(join(dir, "index.html"), "<main>changed</main>");
    await ensureBuild();
    assert.equal((await readFile(join(dir, "events.log"), "utf8")).trim().split("\n").length, 5);
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel initial launches serialize preparation and recognize a symlinked startup owner", async () => {
  const dir = await testFixture("looproom-parallel-launch-");
  const root = join(dir, "app");
  const actualData = join(dir, "data");
  const linkedData = join(dir, "linked-data");
  const children: { child: ReturnType<typeof spawn>; output: () => string; stage: string; port: number }[] = [];
  const freePort = async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((done) => server.close(() => done()));
    return port;
  };
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "server"));
    await mkdir(join(root, "bin"));
    await mkdir(actualData);
    await symlink(actualData, linkedData);
    await copyFile(join(process.cwd(), "scripts", "launch.mjs"), join(root, "scripts", "launch.mjs"));
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", dependencies: { tsx: "1.0.0" } }));
    for (const name of ["package-lock.json", "tsconfig.json", "vite.config.ts", "index.html"])
      await writeFile(join(root, name), name);
    await writeFile(join(root, "bin", "npm"), `#!/bin/sh
if [ "$1" = --version ]; then echo 10.0.0; exit 0; fi
echo "$1 $2" >> events.log
if [ "$1" = ci ]; then
  sleep 1
  mkdir -p node_modules/tsx
  echo '{"type":"module","exports":"./index.js"}' > node_modules/tsx/package.json
  echo '' > node_modules/tsx/index.js
  echo lock > node_modules/.package-lock.json
elif [ "$1" = run ] && [ "$2" = build ]; then
  mkdir -p dist
  cp index.html dist/index.html
fi
`, { mode: 0o755 });
    await writeFile(join(root, "bin", "codex"), "#!/bin/sh\necho 'codex-cli 0.159.2'\n", { mode: 0o755 });
    // The fixture uses native Node TypeScript stripping and needs only a no-op import for tsx.
    await writeFile(join(root, "server", "index.ts"), `import {createServer} from 'node:http';
import {readFile,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const root=resolve('.');
const dataDir=await realpath(process.env.LOOPROOM_DATA_DIR);
const port=Number(process.env.PORT);
let status='starting';
const server=createServer((req,res)=>{res.writeHead(status==='ok'?200:503,{'Content-Type':'application/json'});res.end(JSON.stringify({app:'looproom',status,root,dataDir}));});
await new Promise(done=>server.listen(port,'127.0.0.1',done));
const ownership=new DatabaseSync(join(dataDir,'coordinator-owner.sqlite'));
ownership.exec('BEGIN IMMEDIATE');
await writeFile(join(dataDir,'coordinator-owner.json'),JSON.stringify({root,dataDir,port}));
const count=Number(await readFile(join(dataDir,'writers'),'utf8').catch(()=>0));
await writeFile(join(dataDir,'writers'),String(count+1));
setTimeout(()=>{status='ok';console.log('Looproom coordinator: http://127.0.0.1:'+port);},800);
process.on('SIGTERM',()=>server.close(()=>{ownership.close();process.exit(0)}));
`);
    const firstPort = await freePort();
    let secondPort = await freePort();
    while (secondPort === firstPort) secondPort = await freePort();
    const health = async (port: number) => await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    }).then(async (response) => ({ statusCode: response.status, body: await response.text() }))
      .catch((error) => ({ error: String(error) }));
    const launch = (stage: string, port: number) => {
      const child = spawn(process.execPath, [join(root, "scripts", "launch.mjs")], {
        cwd: root,
        env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH, CODEX_BINARY: join(root, "bin", "codex"), PORT: String(port), LOOPROOM_DATA_DIR: linkedData, LOOPROOM_NO_BROWSER: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => { output += chunk; });
      child.stderr?.on("data", (chunk) => { output += chunk; });
      const entry = { child, output: () => output, stage, port };
      children.push(entry);
      return { ...entry, exit: async () => {
        try {
          return await waitForChildExit(child, entry.output);
        } catch (error) {
          const owner = await readFile(join(actualData, "coordinator-owner.json"), "utf8").catch((readError) => String(readError));
          const diagnostics = await Promise.all([health(firstPort), health(secondPort)]);
          throw new Error(`${stage} on port ${port}: ${String(error)}\nlaunchers: ${children.map(({ stage, port, child, output }) => JSON.stringify({ stage, port, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, output: output() })).join("\n")}\nowner: ${owner}\nhealth ${firstPort}: ${JSON.stringify(diagnostics[0])}\nhealth ${secondPort}: ${JSON.stringify(diagnostics[1])}`);
        }
      } };
    };
    const first = launch("initial owner", firstPort);
    const installationDeadline = Date.now() + 10000;
    while (!(await readFile(join(root, "events.log"), "utf8").catch(() => "")).includes("ci ") && Date.now() < installationDeadline)
      await new Promise((done) => setTimeout(done, 20));
    assert.ok((await readFile(join(root, "events.log"), "utf8")).includes("ci "), first.output());
    const second = launch("parallel second launch", secondPort);
    const deadline = Date.now() + 15000;
    let startup: any;
    while (Date.now() < deadline) {
      startup = await fetch(`http://127.0.0.1:${firstPort}/api/health`).then((r) => r.json()).catch(() => null);
      if (startup?.status === "starting") break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(startup?.dataDir, await realpath(actualData));
    const secondExit = await second.exit();
    assert.equal(secondExit, 0, second.output());
    const events = (await readFile(join(root, "events.log"), "utf8")).trim().split("\n");
    assert.deepEqual(events, ["ci ", "run build"]);
    assert.equal(await readFile(join(actualData, "writers"), "utf8"), "1");
    assert.equal((await readFile(join(actualData, "coordinator-owner.json"), "utf8")).includes(String(firstPort)), true);
    await writeFile(join(root, "bin", "git"), "#!/bin/sh\necho 'git unavailable' >&2\nexit 1\n", { mode: 0o755 });
    await writeFile(join(root, "bin", "codex"), "#!/bin/sh\necho 'codex unavailable' >&2\nexit 1\n", { mode: 0o755 });
    for (const healthyPort of [firstPort, secondPort]) {
      const reopened = launch(`reopen incumbent ${healthyPort}`, healthyPort);
      assert.equal(await reopened.exit(), 0, reopened.output());
    }
    assert.deepEqual((await readFile(join(root, "events.log"), "utf8")).trim().split("\n"), ["ci ", "run build"]);
    await stopChild(first.child, first.output);
    const missingGit = launch("missing Git", firstPort);
    assert.notEqual(await missingGit.exit(), 0);
    assert.match(missingGit.output(), /Git 2\.35 or later is required/);
    await writeFile(join(root, "bin", "git"), "#!/bin/sh\necho 'git version 2.35.0'\n", { mode: 0o755 });
    const missingCodex = launch("missing Codex", firstPort);
    assert.notEqual(await missingCodex.exit(), 0);
    assert.match(missingCodex.output(), /Codex CLI 0\.159\.2 or later is required/);
    await writeFile(join(root, "bin", "codex"), "#!/bin/sh\necho 'codex-cli 0.159.2'\n", { mode: 0o755 });
    // A failed preparation must release the same lock for a later launch.
    await writeFile(join(root, "index.html"), "changed");
    await writeFile(join(root, "bin", "npm"), "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 10.0.0; exit 0; fi\nexit 7\n", { mode: 0o755 });
    const failed = launch("failed build", firstPort);
    assert.notEqual(await failed.exit(), 0);
    assert.match(failed.output(), /npm run build failed/);
    assert.equal((await readFile(join(root, "events.log"), "utf8")).trim().split("\n").length, 2);
    await writeFile(join(root, "bin", "npm"), `#!/bin/sh
if [ "$1" = --version ]; then echo 10.0.0; exit 0; fi
echo "$1 $2" >> events.log
if [ "$1" = run ] && [ "$2" = build ]; then mkdir -p dist; cp index.html dist/index.html; fi
`, { mode: 0o755 });
    const restarted = launch("restart", firstPort);
    let ready: any;
    const retryDeadline = Date.now() + 10000;
    while (Date.now() < retryDeadline) {
      ready = await fetch(`http://127.0.0.1:${firstPort}/api/health`).then((r) => r.json()).catch(() => null);
      if (ready?.status === "ok") break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(ready?.status, "ok", restarted.output());
    assert.equal(await readFile(join(actualData, "writers"), "utf8"), "2");
  } finally {
    await Promise.all(children.map((entry) => stopChild(entry.child, entry.output)));
    await rm(dir, { recursive: true, force: true });
  }
});
