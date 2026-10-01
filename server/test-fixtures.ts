import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Broker checks run with tmpdir denied. Keep disposable test data in this worktree.
const root = fileURLToPath(new URL("../.looproom-test-fixtures/", import.meta.url));

export async function testFixture(prefix: string): Promise<string> {
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}
