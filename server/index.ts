import { escalationMode } from "../src/lib/autonomy.ts";
import express from "express";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, realpath, stat, readFile } from "node:fs/promises";
import { z } from "zod";
import { chooseFolder, droppedFolder } from "./folders.ts";
import { Store } from "./store.ts";
import { Runtime } from "./runtime.ts";
import { Engine } from "./engine.ts";
import { createRepo, inspectRepo, git, gh } from "./git.ts";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir =
  process.env.LOOPROOM_DATA_DIR ??
  join(homedir(), "Library", "Application Support", "Looproom");
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const store = new Store(join(dataDir, "looproom.sqlite"));
const defaults = JSON.parse(
  await readFile(join(appRoot, "config", "model-profiles.json"), "utf8"),
);
try {
  store.get("settings");
} catch (error) {
  if (!(error instanceof Error) || error.message !== "Record not found") throw error;
  const profile = (name: string) => ({
    model: defaults.profiles[name].model,
    effort: defaults.profiles[name].reasoningEffort,
  });
  store.put(
    "settings",
    {
      orchestrator: profile("orchestrator"),
      subagent: profile("subagent"),
      concurrency: 2,
    },
    "settings",
  );
}
if (!store.get("settings").judge)
  store.patch("settings", { judge: { ...store.get("settings").subagent } });
store.recover();
store.syncConversation();
const runtime = new Runtime(
  process.env.CODEX_BINARY ?? "codex",
  join(dataDir, "codex"),
);
const engine = new Engine(store, runtime, dataDir);
const app = express();
const session = randomBytes(32).toString("hex");
const port = Number(process.env.PORT ?? 4319);
app.disable("x-powered-by");
app.use((req, res, next) => {
  const host = req.headers.host?.split(":")[0];
  if (!["127.0.0.1", "localhost"].includes(host ?? "")) {
    res.status(403).json({ error: "Local access only." });
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  const origin = req.headers.origin;
  if (
    origin &&
    ![
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ].includes(origin)
  ) {
    res.status(403).json({ error: "Unrecognized origin." });
    return;
  }
  if (req.path === "/api/state" && req.method === "GET")
    res.cookie("looproom_session", session, {
      httpOnly: true,
      sameSite: "strict",
      path: "/api",
    });
  if (
    req.path.startsWith("/api") &&
    req.method !== "GET" &&
    (!req.headers.cookie
      ?.split(";")
      .some((cookie) => cookie.trim() === "looproom_session=" + session) ||
      req.headers["x-looproom-client"] !== "ui")
  ) {
    res.status(403).json({ error: "Refresh Looproom before making changes." });
    return;
  }
  next();
});
app.use(express.json({ limit: "256kb" }));
const route =
  (
    fn: (req: express.Request, res: express.Response) => Promise<void> | void,
  ): express.RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
let runtimeState: any = {
  connected: false,
  account: null,
  models: [],
  error: null,
};
let runtimeRevision = 0;
async function refreshRuntime() {
  try {
    const [account, models] = await Promise.all([
      runtime.account(),
      runtime.models(),
    ]);
    runtimeState = {
      connected: true,
      account: account.account,
      models: models.data ?? [],
      error: null,
    };
  } catch (error) {
    runtimeState = {
      connected: false,
      account: null,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  runtimeRevision++;
  engine.emit("change");
}
runtime.on("notification", (message) => {
  if (["account/updated", "account/login/completed"].includes(message.method))
    void refreshRuntime();
});
runtime.on("disconnected", (error) => {
  runtimeState = { ...runtimeState, connected: false, error: error.message };
  runtimeRevision++;
  engine.emit("change");
});
app.get("/api/health", (_req, res) =>
  res.json({ app: "looproom", status: "ok" }),
);
let stateCache:
  | { storeRevision: number; runtimeRevision: number; json: string }
  | undefined;
function stateJson() {
  if (
    stateCache?.storeRevision === store.revision &&
    stateCache.runtimeRevision === runtimeRevision
  )
    return stateCache.json;
  const json = JSON.stringify({
    projects: store.all("project"),
    tasks: store.all("task"),
    gates: store.all("gate"),
    agents: store.all("agent"),
    messages: store.conversation(),
    runs: store.all("run").map(({ output, ...run }) => run),
    memory: store.all("memory"),
    events: store.events(),
    settings: store.get("settings"),
    runtime: runtimeState,
  });
  stateCache = { storeRevision: store.revision, runtimeRevision, json };
  return json;
}
app.get("/api/state", (_req, res) => res.type("json").send(stateJson()));
// All SSE clients observe the same invalidation signal. One engine listener and
// one heartbeat suffice regardless of the number of open browser windows.
const eventClients = new Set<express.Response>();
let eventHeartbeat: ReturnType<typeof setInterval> | undefined;
let eventFlush: ReturnType<typeof setTimeout> | undefined;
function writeEvent(res: express.Response, event: string) {
  if (res.destroyed || !res.write(event)) {
    removeEventClient(res);
    res.destroy(); // A slow client reconnects and reads a fresh state snapshot.
  }
}
function broadcastEvent(event: string) {
  for (const client of eventClients) writeEvent(client, event);
}
function scheduleEvent() {
  if (eventFlush) return;
  eventFlush = setTimeout(() => {
    eventFlush = undefined;
    broadcastEvent("data: changed\n\n");
  }, 150);
}
function removeEventClient(res: express.Response) {
  eventClients.delete(res);
  if (eventClients.size) return;
  engine.off("change", scheduleEvent);
  if (eventHeartbeat) clearInterval(eventHeartbeat);
  if (eventFlush) clearTimeout(eventFlush);
  eventHeartbeat = undefined;
  eventFlush = undefined;
}
app.get("/api/events", (req, res) => {
  if (
    !req.headers.cookie
      ?.split(";")
      .some((cookie) => cookie.trim() === "looproom_session=" + session)
  ) {
    res.status(403).end();
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  if (!eventClients.size) {
    engine.on("change", scheduleEvent);
    eventHeartbeat = setInterval(
      () => broadcastEvent(": heartbeat\n\n"),
      15000,
    );
  }
  eventClients.add(res);
  res.once("close", () => removeEventClient(res));
  writeEvent(res, "data: connected\n\n");
});
app.post(
  "/api/runtime/connect",
  route(async (_req, res) => {
    await refreshRuntime();
    res.json(runtimeState);
  }),
);
app.post(
  "/api/runtime/login",
  route(async (_req, res) => {
    const login = await runtime.login();
    res.json(login);
  }),
);
app.post(
  "/api/repos/inspect",
  route(async (req, res) => {
    const body = z
      .object({
        path: z.string().min(1).max(1000),
        mode: z.enum(["existing", "new"]),
      })
      .parse(req.body);
    if (body.mode === "existing") res.json(await inspectRepo(body.path));
    else {
      const path = resolve(body.path);
      await realpath(dirname(path)).catch(() => {
        throw new Error(
          "Parent folder not found. Choose an existing parent folder.",
        );
      });
      const exists = await access(path)
        .then(() => true)
        .catch(() => false);
      if (exists)
        throw new Error(
          "New project folder already exists. Choose another name or open it as an existing project.",
        );
      res.json({ path, branch: "main", remote: "", github: "", dirty: false });
    }
  }),
);
const projectSchema = z.object({
  path: z.string().min(1).max(1000),
  mode: z.enum(["existing", "new"]),
  name: z.string().trim().min(1).max(100),
  goal: z.string().trim().min(5).max(12000),
  constraints: z.string().max(6000),
  checks: z.array(z.string().trim().min(1).max(500)).max(8),
});
app.post(
  "/api/projects",
  route(async (req, res) => {
    const body = projectSchema.parse(req.body);
    const repo =
      body.mode === "new"
        ? await createRepo(body.path)
        : await inspectRepo(body.path);
    const duplicate = store.all("project").find((p) => p.path === repo.path);
    if (duplicate)
      throw new Error(
        "This repository is already connected. Open its project.",
      );
    const project = store.put("project", {
      ...repo,
      name: body.name,
      goal: body.goal,
      constraints: body.constraints,
      checks: body.checks,
      status: "paused",
      planned: false,
      createdAt: new Date().toISOString(),
    });
    for (const role of ["orchestrator", "implementation", "review", "research"])
      store.put("agent", {
        projectId: project.id,
        role,
        createdAt: new Date().toISOString(),
      });
    store.put("message", {
      projectId: project.id,
      role: "human",
      text: body.goal,
      createdAt: new Date().toISOString(),
    });
    engine.changed("project-created", { name: project.name }, project.id);
    res.json(project);
  }),
);
app.post(
  "/api/projects/:id/control",
  route(async (req, res) => {
    const action = z.enum(["start", "pause", "stop"]).parse(req.body.action);
    const id = String(req.params.id),
      project = store.get(id, "project");
    if (action === "start") {
      const repo = await inspectRepo(project.path);
      store.patch(id, {
        ...repo,
        status: "running",
        ...(project.status === "idle" ? { planned: false } : {}),
      });
    } else {
      store.patch(id, { status: action === "pause" ? "paused" : "stopped" });
      for (const run of store
        .all("run", id)
        .filter((run) => run.status === "running" && run.turnId))
        await runtime.interrupt(run.threadId, run.turnId).catch(() => {});
    }
    engine.changed("project-" + action, {}, id);
    res.json(store.get(id, "project"));
  }),
);
app.post(
  "/api/projects/:id/messages",
  route((req, res) => {
    const text = z.string().trim().min(1).max(12000).parse(req.body.text),
      id = String(req.params.id);
    const project = store.get(id, "project");
    if (project.status === "idle")
      store.patch(id, { status: "running", planned: false });
    store.put("message", {
      projectId: id,
      role: "human",
      text,
      createdAt: new Date().toISOString(),
    });
    engine.changed("message-added", {}, id);
    res.json({ ok: true });
  }),
);
const profile = z.object({
  model: z.string().regex(/^gpt-[\w.-]+$/),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
});
app.post(
  "/api/folders/choose",
  route(async (req, res) => {
    const body = z
      .object({ initial: z.string().max(4096).optional() })
      .parse(req.body);
    res.json({ path: await chooseFolder(appRoot, dataDir, body.initial) });
  }),
);
app.post(
  "/api/folders/drop",
  route(async (req, res) => {
    const body = z
      .object({
        names: z.array(z.string().max(255)).min(1).max(1),
        uri: z.string().max(4096).optional(),
      })
      .parse(req.body);
    res.json({
      path: await droppedFolder(appRoot, dataDir, body.names, body.uri),
    });
  }),
);
app.post(
  "/api/settings",
  route((req, res) => {
    const settings = z
      .object({
        orchestrator: profile,
        subagent: profile,
        judge: profile.optional(),
        concurrency: z.number().int().min(1).max(4),
      })
      .parse(req.body);
    res.json(store.patch("settings", settings));
    engine.changed("settings-updated", {});
  }),
);
app.post(
  "/api/projects/:id/settings",
  route((req, res) => {
    const settings = z
      .object({
        checks: z.array(z.string().trim().min(1).max(500)).max(8),
        constraints: z.string().max(6000),
        bypass: z.boolean().optional(),
        escalationMode: z.enum(["human", "bypass", "yolo"]).optional(),
      })
      .parse(req.body);
    const projectId = String(req.params.id),
      previous = store.get(projectId, "project");
    const updated = store.transaction(() => {
      const record = store.patch(projectId, settings);
      if (escalationMode(previous) !== escalationMode(record)) {
        for (const gate of store.all("gate", projectId)) {
          if (
            gate.status === "open" &&
            gate.type !== "pr" &&
            gate.judgeStatus !== "running" &&
            !gate.judgeSubmittedAt
          )
            store.patch(gate.id, {
              judgeStatus: "pending",
              judgeError: null,
              judgeAttempts: 0,
              judgeFailures: 0,
              judgeNextAttemptAt: null,
            });
        }
      }
      return record;
    });
    res.json(updated);
    engine.changed("project-settings-updated", {}, String(req.params.id));
  }),
);
app.get(
  "/api/gates/:id/pr",
  route(async (req, res) => {
    res.json(await engine.prInfo(String(req.params.id)));
  }),
);
app.get(
  "/api/gates/:id/diff",
  route(async (req, res) => {
    const gate = store.get(String(req.params.id), "gate");
    if (gate.type !== "pr") throw new Error("Not a PR gate.");
    res.json({ diff: await gh(["pr", "diff", gate.pr]) });
  }),
);
app.post(
  "/api/gates/:id/approve",
  route(async (req, res) => {
    const sha = z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(req.body.sha);
    await engine.approve(String(req.params.id), sha);
    res.json({ ok: true });
  }),
);
app.post(
  "/api/gates/:id/changes",
  route(async (req, res) => {
    const body = z
      .object({
        sha: z.string().regex(/^[a-f0-9]{40}$/),
        answer: z.string().trim().min(1).max(6000),
      })
      .parse(req.body);
    await engine.requestChanges(String(req.params.id), body.sha, body.answer);
    res.json({ ok: true });
  }),
);
app.post(
  "/api/gates/:id/resolve",
  route(async (req, res) => {
    const body = z
      .object({
        answer: z.string().trim().min(1).max(6000),
        retry: z.boolean(),
      })
      .parse(req.body);
    await engine.resolve(String(req.params.id), body.answer, body.retry);
    res.json({ ok: true });
  }),
);
app.post(
  "/api/gates/:id/judge",
  route((req, res) => {
    const gate = store.get(String(req.params.id), "gate"),
      project = store.get(gate.projectId, "project");
    if (gate.status !== "open")
      throw new Error("Judge drafting is unavailable for this gate.");
    if (gate.judgeStatus === "running")
      throw new Error("The judge is already working.");
    store.patch(gate.id, {
      judgeStatus: "pending",
      judgeError: null,
      judgeAttempts: 0,
      judgeFailures: 0,
      judgeNextAttemptAt: null,
    });
    engine.changed("judge-requested", { gateId: gate.id }, project.id);
    res.json({ ok: true });
  }),
);
app.get("/api/projects/:id/memory", (req, res) => {
  const projectId = String(req.params.id);
  store.get(projectId, "project");
  res.json(store.search(projectId, String(req.query.q ?? "")));
});
app.get(
  "/api/tasks/:id/diff",
  route(async (req, res) => {
    const task = store.get(String(req.params.id), "task");
    res.json({
      diff: task.worktree ? await git(task.worktree, ["diff", "HEAD"]) : "",
    });
  }),
);
app.use(express.static(join(appRoot, "dist")));
app.get(
  "/{*path}",
  route(async (_req, res) => {
    const file = join(appRoot, "dist", "index.html");
    if (await stat(file).catch(() => null)) res.sendFile(file);
    else
      res.status(404).json({
        error: "Start npm run dev, or npm run build before npm start.",
      });
  }),
);
app.use(
  (
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(error instanceof z.ZodError ? 400 : 409).json({
      error:
        error instanceof z.ZodError
          ? error.issues
              .map((i) => i.path.join(".") + ": " + i.message)
              .join("; ")
          : (error.message ?? "Request failed."),
    });
  },
);
const server = app.listen(port, "127.0.0.1");
server.once("listening", () => {
  console.log(
    `Looproom coordinator: http://127.0.0.1:${(server.address() as any).port}`,
  );
  void refreshRuntime();
  engine.start();
});
server.on("error", (error) => {
  console.error("Looproom could not start: " + error.message);
  engine.close();
  store.close();
  process.exit(1);
});
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  engine.close();
  for (const client of eventClients) client.end();
  const forceConnections = setTimeout(() => {
    console.error("Looproom shutdown: closing stalled HTTP connections.");
    server.closeAllConnections();
  }, 30_000);
  forceConnections.unref();
  server.close(() => {
    clearTimeout(forceConnections);
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
