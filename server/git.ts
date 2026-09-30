import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
export const exec = promisify(execFile);
export async function git(path: string, args: string[]) {
  return (
    await exec("git", ["-C", path, ...args], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
}
export async function inspectRepo(input: string) {
  const path = await realpath(resolve(input)).catch(() => {
    throw new Error("Folder not found. Check the path and try again.");
  });
  if (!(await stat(path)).isDirectory())
    throw new Error("Choose a project folder.");
  let root: string;
  try {
    root = await git(path, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(
      "This folder is not a Git repository. Choose Create project or initialize Git first.",
    );
  }
  await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => {
    throw new Error(
      "Repository needs an initial commit before worktrees can run.",
    );
  });
  const branch = await git(root, ["branch", "--show-current"]);
  const remote = await git(root, ["remote", "get-url", "origin"]).catch(
    () => "",
  );
  const dirty = !!(await git(root, ["status", "--porcelain"]));
  const github =
    remote.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? "";
  return {
    path: root,
    branch: branch || "detached HEAD",
    remote,
    github,
    dirty,
  };
}
export async function createRepo(input: string) {
  const path = resolve(input);
  await mkdir(path, { recursive: false });
  await git(path, ["init", "-b", "main"]);
  await git(path, [
    "-c",
    "user.name=Looproom",
    "-c",
    "user.email=looproom@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "Initialize project",
  ]);
  return inspectRepo(path);
}
export async function createWorktree(
  repo: string,
  dataDir: string,
  id: string,
  base = "HEAD",
) {
  const path = join(dataDir, "worktrees", id);
  await mkdir(join(dataDir, "worktrees"), { recursive: true });
  const branch = "looproom/" + id;
  if (await stat(path).catch(() => null)) {
    const actualBranch = await git(path, ["branch", "--show-current"]);
    const original = await git(repo, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const existing = await git(path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (
      actualBranch !== branch ||
      (await realpath(original)) !== (await realpath(existing))
    )
      throw new Error(
        "Preserved worktree does not match this task. Review it before retrying.",
      );
  } else await git(repo, ["worktree", "add", "-b", branch, path, base]);
  return { path, branch };
}
export function checkApproval(
  expected: string,
  actual: string,
  checks: any[],
  mergeable: string,
) {
  if (expected !== actual)
    throw new Error("PR revision changed. Refresh and review the new commit.");
  if (mergeable !== "MERGEABLE")
    throw new Error(
      "GitHub has not confirmed this PR can merge. Resolve conflicts or refresh.",
    );
  const bad = checks.filter((check) =>
    check.__typename === "CheckRun"
      ? check.status !== "COMPLETED" ||
        !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion)
      : check.state !== "SUCCESS",
  );
  if (bad.length) throw new Error("GitHub checks are pending or failing.");
}
export async function gh(args: string[]) {
  return (
    await exec("gh", args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  ).stdout.trim();
}
export async function sandboxCheck(
  binary: string,
  cwd: string,
  command: string,
  codexHome: string,
) {
  const { permissionConfig, configArgs } = await import("./permissions.ts");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const config = await permissionConfig(cwd, true);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CODEX_HOME: codexHome,
    TMPDIR: process.env.TMPDIR,
  };
  return new Promise<{ command: string; code: number; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        binary,
        [
          "sandbox",
          "--permission-profile",
          "looproom",
          "-C",
          cwd,
          ...configArgs(config),
          "--",
          "/bin/zsh",
          "-f",
          "-c",
          command,
        ],
        { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
      const read = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-100_000);
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ command, code: code ?? 1, output });
      });
    },
  );
}
