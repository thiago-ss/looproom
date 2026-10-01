import { testFixture } from "./test-fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { runVerification, sourceFingerprint, cleanupTestFixtures, npmReadRoot } from "./verification.ts";
test("unrecognized npm layouts cannot grant read access to a broad parent", () => {
  assert.equal(npmReadRoot("/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js"), "/opt/homebrew/lib/node_modules/npm");
  for (const path of ["/usr/local/bin/npm", "/custom/tool/bin/npm-cli.js", "/npm-cli.js"])
    assert.equal(npmReadRoot(path), path);
});

test(
  "native verifier isolates source, secrets, Internet and coordinator while allowing children and local fixtures",
  {
    skip:
      process.platform !== "darwin" || !!process.env.LOOPROOM_VERIFICATION_JOB,
  },
  async () => {
    const dir = await testFixture("looproom-verifier-"),
      cwd = join(dir, "source");
    await mkdir(cwd);
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "preserve");
    await mkdir(join(cwd, ".looproom-test-fixtures"));
    await symlink(outside, join(cwd, ".looproom-test-fixtures/old-outside-link"));
    await writeFile(join(cwd, ".env.production"), "fixture-secret");
    await symlink(outside, join(cwd, "outside-link"));
    await writeFile(
      join(cwd, "probe.cjs"),
      `
const fs=require('node:fs'),net=require('node:net'),http=require('node:http'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
assert.equal(process.env.LOOPROOM_SECRET_FIXTURE,undefined);
for(const path of [${JSON.stringify(outside)},'outside-link','.env.production'])assert.throws(()=>fs.readFileSync(path));
assert.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'tamper'));
assert.throws(()=>fs.writeFileSync('.git/config','tamper'));
assert.throws(()=>fs.writeFileSync('../policy.sb','(version 1) (allow default)'));
fs.writeFileSync('.env.created','fake-secret');assert.throws(()=>fs.readFileSync('.env.created'));
assert.equal(spawnSync('/bin/echo',['child'],{encoding:'utf8'}).stdout.trim(),'child');
fs.mkdirSync('fixture');fs.rmdirSync('fixture');fs.writeFileSync('only-snapshot.txt','isolated');
const denied=host=>new Promise((ok,no)=>{const socket=net.connect(4319,host,()=>{socket.destroy();no(Error('Unexpected network access'));});socket.on('error',e=>{assert.ok(['EPERM','EACCES'].includes(e.code),e.code);ok();});socket.setTimeout(1500,()=>{socket.destroy();no(Error('Policy did not reject access'));});});
await denied('127.0.0.1');await denied('::1');await denied('1.1.1.1');
const server=http.createServer((req,res)=>res.end('local'));
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
assert.equal(await (await fetch('http://127.0.0.1:'+server.address().port)).text(),'local');server.close();
console.log('All native boundaries passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
`,
    );
    const old = process.env.LOOPROOM_SECRET_FIXTURE;
    process.env.LOOPROOM_SECRET_FIXTURE = "must-not-inherit";
    try {
      const hash = await sourceFingerprint(cwd);
      const r = await runVerification({
        cwd,
        commands: ["node probe.cjs", "exit 7"],
        dataDir: dir,
        codexBinary: "codex",
        timeoutMs: 10_000,
        cleanupFixtures: true,
      });
      assert.equal(r.results[0].code, 0, r.results[0].output);
      assert.match(r.results[0].output, /All native boundaries passed/);
      assert.equal(r.results[1].code, 7);
      assert.equal(r.sourceUnchanged, true);
      assert.equal(r.fixtureCleanup?.removed, true);
      assert.equal((await readdir(cwd)).includes(".looproom-test-fixtures"), false);
      assert.equal(r.sourceHash, hash);
      assert.equal(await readFile(outside, "utf8"), "preserve");
      assert.equal(await sourceFingerprint(cwd), hash);
      assert.equal(
        (await readdir(join(dir, "verification"))).every((x) =>
          x.endsWith(".json"),
        ),
        true,
      );
      const timeout = await runVerification({
        cwd,
        commands: ["node -e 'setInterval(()=>{},1000)'"],
        dataDir: dir,
        codexBinary: "codex",
        timeoutMs: 250,
      });
      assert.equal(timeout.results[0].code, 124);
      assert.equal(timeout.results[0].timedOut, true);
      const started = Date.now();
      const nativeTimeout = await runVerification({
        cwd,
        commands: ["codex sandbox -C \"$PWD\" -- /bin/zsh -f -c 'while true; do :; done'"],
        dataDir: dir, codexBinary: "codex", timeoutMs: 500,
      });
      assert.equal(nativeTimeout.results[0].code, 124);
      assert.ok(Date.now() - started < 5000, "Native broker child must be cancelled with the job");
    } finally {
      if (old === undefined) delete process.env.LOOPROOM_SECRET_FIXTURE;
      else process.env.LOOPROOM_SECRET_FIXTURE = old;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("coordinator fixture cleanup rejects a symlinked scratch root", async () => {
  const dir = await testFixture("looproom-cleanup-");
  try {
    const cwd = join(dir, "source"), outside = join(dir, "outside");
    await mkdir(cwd); await mkdir(outside);
    await writeFile(join(outside, "preserve"), "preserve");
    await symlink(outside, join(cwd, ".looproom-test-fixtures"));
    await assert.rejects(cleanupTestFixtures(cwd), /real reserved scratch directory/);
    assert.equal(await readFile(join(outside, "preserve"), "utf8"), "preserve");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
