import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { testFixture } from "./test-fixtures.ts";
import {
  checkApproval,
  createRepo,
  createWorktree,
  git,
  inspectRepo,
} from "./git.ts";
import { validateDependencies } from "./engine.ts";

test("merge preflight rejects changed revisions, conflicts, pending and failed checks", () => {
  const sha = "a".repeat(40);
  assert.throws(
    () => checkApproval(sha, "b".repeat(40), [], "MERGEABLE"),
    /revision changed/,
  );
  assert.throws(() => checkApproval(sha, sha, [], "CONFLICTING"), /conflicts/);
  assert.throws(
    () =>
      checkApproval(
        sha,
        sha,
        [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }],
        "MERGEABLE",
      ),
    /pending/,
  );
  assert.throws(
    () =>
      checkApproval(
        sha,
        sha,
        [{ __typename: "StatusContext", state: "FAILURE" }],
        "MERGEABLE",
      ),
    /failing/,
  );
  assert.doesNotThrow(() =>
    checkApproval(
      sha,
      sha,
      [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      "MERGEABLE",
    ),
  );
});

test("dependency frontier rejects invalid edges and cycles", () => {
  assert.doesNotThrow(() =>
    validateDependencies([{ dependencies: [] }, { dependencies: [0] }]),
  );
  assert.throws(
    () => validateDependencies([{ dependencies: [1] }, { dependencies: [0] }]),
    /cycle/,
  );
  for (const dependencies of [[0], [-1], [1], [0.5]])
    assert.throws(() => validateDependencies([{ dependencies }]), /invalid/);
});

test("a task worktree preserves uncommitted changes in the original checkout", async () => {
  const dir = await testFixture("looproom-git-");
  try {
    const repo = await createRepo(join(dir, "repo"));
    await writeFile(join(repo.path, "existing.txt"), "committed");
    await git(repo.path, ["add", "."]);
    await git(repo.path, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "fixture",
    ]);
    await writeFile(join(repo.path, "existing.txt"), "human edits");
    const tree = await createWorktree(repo.path, join(dir, "data"), "task");
    assert.equal(
      await readFile(join(tree.path, "existing.txt"), "utf8"),
      "committed",
    );
    await writeFile(join(tree.path, "existing.txt"), "agent edits");
    assert.equal(
      await readFile(join(repo.path, "existing.txt"), "utf8"),
      "human edits",
    );
    assert.equal((await inspectRepo(repo.path)).dirty, true);
    assert.deepEqual(
      await createWorktree(repo.path, join(dir, "data"), "task"),
      tree,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
