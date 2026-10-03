import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../server/store.ts";
import { testFixture } from "../server/test-fixtures.ts";

const samples = 40;
const clients = 32;
const quantile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
};
const dir = await testFixture("looproom-state-stress-");
let child: ReturnType<typeof spawn> | undefined;
try {
  const store = new Store(join(dir, "looproom.sqlite"));
  for (let p = 0; p < 4; p++) {
    const projectId = `stress-project-${p}`;
    store.put("project", { name: `Stress ${p}`, status: "paused", planned: true }, projectId);
    for (let i = 0; i < 250; i++) {
      store.put("task", { projectId, title: `Task ${i}`, status: "completed" }, `${projectId}-task-${i}`);
      store.put("message", { projectId, role: "human", text: `Message ${i}`, createdAt: new Date(1_700_000_000_000 + i).toISOString() });
      store.put("run", { projectId, taskId: `${projectId}-task-${i}`, status: "completed", output: "x".repeat(1000) });
    }
    for (let i = 0; i < 500; i++) store.event("stress-event", { ordinal: i }, projectId);
  }
  store.close();
  let stderr = "";
  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, PORT: "0", LOOPROOM_DATA_DIR: dir, CODEX_BINARY: join(dir, "missing-codex") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
  const url = await Promise.race([
    (async () => {
      let stdout = "";
      for await (const chunk of child!.stdout!) {
        stdout += chunk;
        const match = stdout.match(/coordinator: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) return match[1];
      }
      throw new Error("Server exited: " + stderr);
    })(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Server startup timed out")), 15_000)),
  ]);
  const first = await fetch(url + "/api/state");
  const cookie = first.headers.get("set-cookie")?.split(";")[0];
  if (!first.ok || !cookie) throw new Error("Session setup failed");
  const initial = await first.json();
  const lengths = Object.fromEntries(["projects", "tasks", "messages", "runs", "events"].map((key) => [key, initial[key].length]));
  if (lengths.projects !== 4 || lengths.tasks !== 1000 || lengths.messages !== 1000 || lengths.runs !== 1000 || lengths.events !== 80)
    throw new Error("State contract mismatch: " + JSON.stringify(lengths));
  if (initial.runs.some((run: { output?: string }) => "output" in run))
    throw new Error("State leaked run output");

  const streams: { controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> }[] = [];
  for (let i = 0; i < clients; i++) {
    const controller = new AbortController();
    const response = await fetch(url + "/api/events", { headers: { cookie }, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Event stream ${i} failed`);
    const reader = response.body.getReader();
    await reader.read();
    streams.push({ controller, reader });
  }
  const timings: number[] = [];
  const bytes: number[] = [];
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    const response = await fetch(url + "/api/state");
    const body = await response.arrayBuffer();
    if (!response.ok) throw new Error("State read failed");
    timings.push(performance.now() - started);
    bytes.push(body.byteLength);
  }
  const changed = streams.map(async ({ reader }) => {
    const deadline = setTimeout(() => { void reader.cancel(); }, 5000);
    try {
      let text = "";
      while (!text.includes("data: changed\n\n")) {
        const item = await reader.read();
        if (item.done) throw new Error("Event stream closed before update");
        text += new TextDecoder().decode(item.value);
      }
      return performance.now();
    } finally { clearTimeout(deadline); }
  });
  const changedAt = performance.now();
  const mutation = await fetch(url + "/api/projects/stress-project-0/messages", {
    method: "POST", headers: { cookie, "x-looproom-client": "ui", "content-type": "application/json" },
    body: JSON.stringify({ text: "Stress mutation" }),
  });
  if (!mutation.ok) throw new Error(`Mutation failed: ${mutation.status}`);
  const eventTimes = await Promise.all(changed);
  for (const stream of streams) stream.controller.abort();
  const after = await (await fetch(url + "/api/state")).json();
  if (after.messages.length !== initial.messages.length + 1 || after.events.length !== 80)
    throw new Error("Mutation/state contract mismatch");
  if (stderr.includes("MaxListenersExceededWarning"))
    throw new Error("Event stream listener count exceeded Node's limit");
  console.log(JSON.stringify({ samples, clients, dataset: lengths, stateBytes: quantile(bytes, 0.5), stateMedianMs: quantile(timings, 0.5), stateP95Ms: quantile(timings, 0.95), eventMedianMs: quantile(eventTimes.map((t) => t - changedAt), 0.5), eventP95Ms: quantile(eventTimes.map((t) => t - changedAt), 0.95), stderr, raw: { timings, bytes, eventTimesMs: eventTimes.map((t) => t - changedAt) } }, null, 2));
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await once(child, "close");
  }
  await rm(dir, { recursive: true, force: true });
}
