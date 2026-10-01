import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../server/store.ts";
import { testFixture } from "../server/test-fixtures.ts";

// Fixed evaluator. Change this file only with a new, explicitly recorded baseline.
const repetitions = 5;
const timeoutMs = 30_000;
let stderr = "";
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let dir: string | undefined;
let store: Store | undefined;
let child: ReturnType<typeof spawn> | undefined;
let measurementFailed = false;
try {
  dir = await testFixture("looproom-refresh-");
  store = new Store(join(dir, "looproom.sqlite"));
  for (let project = 0; project < 4; project++) {
    const id = `benchmark-project-${project}`;
    store.put("project", {
      name: `Project ${project}`,
      goal: "Measure local refresh behavior",
      status: "paused",
      planned: true,
    }, id);
    for (let task = 0; task < 12; task++)
      store.put("task", {
        projectId: id,
        title: `Task ${task}`,
        status: "completed",
        acceptance: ["Existing acceptance criterion"],
      }, `${id}-task-${task}`);
    for (let event = 0; event < 20; event++)
      store.event("benchmark-event", { ordinal: event }, id);
  }
  store.close();
  store = undefined;

  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: {
      ...process.env,
      PORT: "0",
      LOOPROOM_DATA_DIR: dir,
      CODEX_BINARY: join(dir, "missing-codex"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const coordinator = child;
  const spawnFailure = new Promise<never>((_, reject) => coordinator.once("error", reject));
  coordinator.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
  const deadline = AbortSignal.timeout(timeoutMs);
  async function listen(): Promise<string> {
    let output = "";
    for await (const chunk of coordinator.stdout!) {
      output += chunk.toString();
      const match = output.match(/coordinator: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) return match[1];
      if (deadline.aborted) throw new Error("Coordinator startup timed out");
    }
    throw new Error("Coordinator exited before startup: " + stderr);
  }
  const url = await Promise.race([
    listen(),
    spawnFailure,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Coordinator startup timed out")), timeoutMs).unref();
    }),
  ]);
  const first = await fetch(url + "/api/state", { signal: deadline });
  const cookie = first.headers.get("set-cookie")?.split(";")[0];
  if (!cookie || !first.ok) throw new Error("Could not establish local session");
  const bytes: number[] = [], coordinatorMs: number[] = [], updateMs: number[] = [];
  for (let i = 0; i < repetitions; i++) {
    const start = performance.now();
    const response = await fetch(url + "/api/state", { signal: deadline });
    const body = await response.arrayBuffer();
    if (!response.ok) throw new Error("Refresh failed: " + response.status);
    coordinatorMs.push(performance.now() - start); // local HTTP round trip, including JSON transfer
    bytes.push(body.byteLength);

    const controller = new AbortController();
    const eventResponse = await fetch(url + "/api/events", {
      headers: { cookie }, signal: AbortSignal.any([controller.signal, deadline]),
    });
    if (!eventResponse.ok || !eventResponse.body) throw new Error("Event stream failed");
    const reader = eventResponse.body.getReader();
    await reader.read(); // initial connected event
    const changed = (async () => {
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Event stream closed before update");
        text += decoder.decode(value);
        if (text.includes("data: changed\n\n")) return performance.now();
      }
    })();
    const updateStart = performance.now();
    const mutation = await fetch(url + "/api/projects/benchmark-project-0/messages", {
      method: "POST",
      headers: { cookie, "x-looproom-client": "ui", "content-type": "application/json" },
      body: JSON.stringify({ text: `Benchmark update ${i}` }),
      signal: deadline,
    });
    if (!mutation.ok) throw new Error("Update failed: " + mutation.status);
    updateMs.push((await changed) - updateStart);
    controller.abort();
  }
  console.log(JSON.stringify({
    repetitions,
    workload: "4 paused projects, 48 completed tasks, 80 events, 5 message updates",
    baselineRefreshBytes: median(bytes),
    baselineCoordinatorRoundTripMs: median(coordinatorMs),
    baselineUpdateLatencyMs: median(updateMs),
    raw: { bytes, coordinatorMs, updateMs },
  }, null, 2));
} catch (error) {
  measurementFailed = true;
  throw error;
} finally {
  let cleanupError: unknown;
  try {
    store?.close();
  } catch (error) {
    cleanupError = error;
  }
  try {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "close");
    }
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    if (dir) await rm(dir, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError && !measurementFailed) throw cleanupError;
  if (cleanupError) console.error("Fixture cleanup also failed:", cleanupError);
}
