import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxCheck, exec, git } from "./git.ts";

test(
  "native macOS policy denies outside reads/writes, local network, and workspace secrets",
  { skip: process.platform !== "darwin" },
  async () => {
    await exec("codex", ["--version"]);
    const dir = await mkdtemp(join(tmpdir(), "looproom-native-")),
      work = join(dir, "work");
    await mkdir(work);
    await git(work, ["init", "-b", "main"]);
    await writeFile(join(dir, "outside"), "preserve");
    await writeFile(join(work, ".env.production"), "fixture-secret");
    try {
      const result = await sandboxCheck(
        "codex",
        work,
        "git rev-parse --is-inside-work-tree; node --version; npm --version; print tamper > .git/config; print inside > inside.txt; print overwrite > ../outside; /bin/cat ../outside; /bin/cat .env.production; /usr/bin/curl --max-time 2 -s -o /dev/null http://127.0.0.1:4319/api/health; print network-exit:$?",
        join(dir, "codex"),
      );
      assert.equal(
        await readFile(join(work, "inside.txt"), "utf8"),
        "inside\n",
      );
      assert.equal(await readFile(join(dir, "outside"), "utf8"), "preserve");
      assert.match(result.output, /true/);
      assert.match(result.output, /v\d+\.\d+\.\d+/);
      assert.doesNotMatch(
        result.output,
        /Cannot find module|OpenSSL configuration error|developer tools/,
      );
      assert.doesNotMatch(
        await readFile(join(work, ".git/config"), "utf8"),
        /tamper/,
      );
      assert.match(result.output, /Operation not permitted/i);
      assert.doesNotMatch(result.output, /fixture-secret/);
      assert.match(result.output, /network-exit:[1-9]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
