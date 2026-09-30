import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareDependencies } from "./dependencies.ts";

test("dependency reuse requires identical lockfiles and never overwrites an existing task install", async () => {
  const dir = await mkdtemp(join(tmpdir(), "looproom-deps-"));
  const repo = join(dir, "repo"),
    task = join(dir, "task");
  await mkdir(join(repo, "node_modules"), { recursive: true });
  await mkdir(task);
  await writeFile(join(repo, "package-lock.json"), "approved lock");
  await writeFile(join(task, "package-lock.json"), "different lock");
  await writeFile(
    join(repo, "node_modules", "fixture.txt"),
    "installed source",
  );
  try {
    assert.equal(await prepareDependencies(repo, task), false);
    await writeFile(join(task, "package-lock.json"), "approved lock");
    assert.equal(await prepareDependencies(repo, task), true);
    assert.equal(
      await readFile(join(task, "node_modules", "fixture.txt"), "utf8"),
      "installed source",
    );
    await writeFile(join(task, "node_modules", "fixture.txt"), "task install");
    assert.equal(await prepareDependencies(repo, task), false);
    assert.equal(
      await readFile(join(task, "node_modules", "fixture.txt"), "utf8"),
      "task install",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
