import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { sandboxCheck, exec } from "./git.ts";
import { testFixture } from "./test-fixtures.ts";
import { npmReadPath, permissionConfig } from "./permissions.ts";

test("npm permission scope only expands a recognized package layout", () => {
  assert.equal(npmReadPath("/tools/npm/bin/npm-cli.js"), "/tools/npm");
  assert.equal(npmReadPath("/tools/shared/bin/npm"), "/tools/shared/bin/npm");
  assert.equal(npmReadPath("/tools/npm-cli.js"), "/tools/npm-cli.js");
});

test(
  "native macOS policy denies outside reads/writes and network; secret paths remain denied",
  { skip: process.platform !== "darwin" },
  async () => {
    await exec("codex", ["--version"]);
    const dir = await testFixture("looproom-native-"),
      work = join(dir, "work");
    await mkdir(work);
    await writeFile(join(dir, "outside"), "preserve");
    await writeFile(join(work, ".env.production"), "fixture-secret");
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end("reachable");
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const port = (server.address() as { port: number }).port;
      const config = await permissionConfig(work, true);
      const filesystem = config.permissions.looproom.filesystem;
      assert.equal(filesystem[work]["**/.env.*"], "deny");
      assert.equal(filesystem[work]["**/*.key"], "deny");
      assert.equal(filesystem[":tmpdir"], "deny");
      const result = await sandboxCheck(
        "codex",
        work,
        `print inside > inside.txt; print overwrite > ../outside; /bin/cat ../outside; /bin/cat .env.production; /usr/bin/curl --max-time 2 -s -o /dev/null http://127.0.0.1:${port}/; print network-exit:$?`,
        join(dir, "codex"),
      );
      assert.equal(
        await readFile(join(work, "inside.txt"), "utf8"),
        "inside\n",
      );
      assert.equal(await readFile(join(dir, "outside"), "utf8"), "preserve");
      assert.match(result.output, /Operation not permitted/i);
      assert.doesNotMatch(result.output, /preserve/);
      assert.doesNotMatch(result.output, /fixture-secret/);
      assert.match(result.output, /network-exit:[1-9]/);
      assert.equal(requests, 0);
    } finally {
      if (server.listening) server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
