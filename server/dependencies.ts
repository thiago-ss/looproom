import { cp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// Reuse an installed dependency tree only when both npm locks match exactly.
// No network, lifecycle scripts, lockfile edits or fallback installation.
export async function prepareDependencies(repo: string, worktree: string) {
  const destination = join(worktree, "node_modules");
  if (await stat(destination).catch(() => null)) return false;
  const [sourceLock, taskLock, installed] = await Promise.all([
    readFile(join(repo, "package-lock.json")).catch(() => null),
    readFile(join(worktree, "package-lock.json")).catch(() => null),
    stat(join(repo, "node_modules")).catch(() => null),
  ]);
  if (
    !sourceLock ||
    !taskLock ||
    !installed?.isDirectory() ||
    !sourceLock.equals(taskLock)
  )
    return false;
  await cp(join(repo, "node_modules"), destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  return true;
}
