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
} catch {
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
  engine.emit("change");
}
runtime.on("notification", (message) => {
  if (["account/updated", "account/login/completed"].includes(message.method))
    void refreshRuntime();
});
runtime.on("disconnected", (error) => {
  runtimeState = { ...runtimeState, connected: false, error: error.message };
  engine.emit("change");
});
app.get("/api/health", (_req, res) =>
  res.json({ app: "looproom", status: "ok" }),
);
app.get("/api/state", (_req, res) =>
  res.json({
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
  }),
);
app.get("/api/events", (req, res) => {
  if (!req.headers.cookie?.includes("looproom_session=" + session)) {
    res.status(403).end();
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  let pending = false;
  const listener = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (!res.destroyed) res.write("data: changed\n\n");
    }, 150);
  };
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
  engine.on("change", listener);
  res.write("data: connected\n\n");
  req.on("close", () => {
    clearInterval(heartbeat);
    engine.off("change", listener);
  });
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
      project = store.get(id);
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
    res.json(store.get(id));
  }),
);
app.post(
  "/api/projects/:id/messages",
  route((req, res) => {
    const text = z.string().trim().min(1).max(12000).parse(req.body.text),
      id = String(req.params.id);
    const project = store.get(id);
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
      previous = store.get(projectId);
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
    const gate = store.get(String(req.params.id));
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
    const gate = store.get(String(req.params.id)),
      project = store.get(gate.projectId);
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
app.get("/api/projects/:id/memory", (req, res) =>
  res.json(store.search(String(req.params.id), String(req.query.q ?? ""))),
);
app.get(
  "/api/tasks/:id/diff",
  route(async (req, res) => {
    const task = store.get(String(req.params.id));
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
const server = app.listen(port, "127.0.0.1", () => {
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
function shutdown() {
  engine.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
