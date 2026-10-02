import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "./store.ts";
import { testFixture } from "./test-fixtures.ts";

test("damaged SQLite fails before schema initialization and keeps its bytes", async () => {
  const dir = await testFixture("looproom-damaged-db-");
  const path = join(dir, "looproom.sqlite");
  const bytes = Buffer.from("not a SQLite database; preserve this evidence");
  try {
    await writeFile(path, bytes);
    assert.throws(() => new Store(path));
    assert.deepEqual(await readFile(path), bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SIGTERM closes an open event stream and checkpoints durable SQLite state", async () => {
  const dir = await testFixture("looproom-shutdown-db-");
  const dataDir = join(dir, "data");
  const path = join(dataDir, "looproom.sqlite");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      env: {
        ...process.env,
        PORT: "0",
        LOOPROOM_DATA_DIR: dataDir,
        CODEX_BINARY: join(dir, "missing-codex"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const serverChild = child;
    const url = await Promise.race([
      (async () => {
        let stdout = "";
        for await (const chunk of serverChild.stdout!) {
          stdout += chunk.toString();
          const match = stdout.match(/coordinator: (http:\/\/127\.0\.0\.1:\d+)/);
          if (match) return match[1];
        }
        throw new Error("Server exited before startup");
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Server startup timed out")), 10_000).unref(),
      ),
    ]);
    const state = await fetch(url + "/api/state");
    const cookie = state.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    assert.equal((await state.json()).settings.orchestrator.model, "gpt-6.1-sol");
    const stream = await fetch(url + "/api/events", { headers: { cookie } });
    assert.equal(stream.status, 200);
    assert.ok(stream.body);
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: connected/);
    assert.ok((await stat(path + "-wal")).size > 0);
    const started = performance.now();
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "close"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Shutdown stalled with an open SSE client")), 5_000).unref(),
      ),
    ]);
    assert.equal(child.exitCode, 0);
    assert.ok(performance.now() - started < 5_000);
    assert.equal(await stat(path + "-wal").then((file) => file.size).catch(() => 0), 0);
    const reopened = new Store(path);
    try {
      assert.equal(reopened.get("settings").orchestrator.model, "gpt-6.1-sol");
      assert.equal(
        (reopened.db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check,
        "ok",
      );
    } finally {
      reopened.close();
    }
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "close");
    }
    await rm(dir, { recursive: true, force: true });
  }
});
