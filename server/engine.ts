import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Store, type RecordData } from "./store.ts";
import { prepareDependencies } from "./dependencies.ts";
import { Runtime } from "./runtime.ts";
import { escalationMode } from "../src/lib/autonomy.ts";
import {
  inspectRepo,
  checkApproval,
  createWorktree,
  git,
  gh,
  sandboxCheck,
} from "./git.ts";

const TaskPlan = z.object({
  title: z.string(),
  description: z.string(),
  acceptance: z.array(z.string()),
  dependencies: z.array(z.number().int()),
  kind: z.enum(["implementation", "research"]),
});
const Plan = z.object({
  summary: z.string(),
  gate: z.string(),
  tasks: z.array(TaskPlan).max(6),
  sources: z.array(z.string()),
});
const Result = z.object({
  summary: z.string(),
  sources: z.array(z.string()),
  humanQuestion: z.string(),
});
const Review = z.object({
  verdict: z.enum(["pass", "changes", "gate"]),
  summary: z.string(),
  sources: z.array(z.string()),
});
const Judgment = z.object({
  action: z.enum(["retry", "skip", "wait"]),
  answer: z.string().trim().min(1).max(6000),
  summary: z.string(),
  sources: z.array(z.string()),
});
export function validateDependencies(tasks: { dependencies: number[] }[]) {
  const active = new Set<number>(),
    done = new Set<number>();
  function visit(i: number) {
    if (active.has(i)) throw new Error("Plan contains a dependency cycle.");
    if (done.has(i)) return;
    active.add(i);
    for (const dependency of tasks[i].dependencies) {
      if (
        !Number.isInteger(dependency) ||
        dependency < 0 ||
        dependency >= tasks.length ||
        dependency === i
      )
        throw new Error("Plan contains an invalid dependency.");
      visit(dependency);
    }
    active.delete(i);
    done.add(i);
  }
  tasks.forEach((_, i) => visit(i));
}
const WORKFLOW = `Use Looproom's versioned adaptation of Matt Pocock's Wayfinder -> primary-source research -> spec/tickets -> implement. Routine questions are answered from repository evidence with assumptions recorded. Never impersonate a human in original HITL steps. Ponytail: reuse existing behavior, standard library and native features before adding code/dependencies. Preserve accessibility and validation. Cite repo files and primary sources. Karpathy LLM Wiki: source-backed outcomes, explicit contradictions; your own previous output is not independent evidence. Autoresearch: bounded changes, frozen acceptance criteria, measurable baseline/candidate, keep or discard; never change the evaluator to improve the score. Jev retrieval is a candidate to compare against FTS5, not a claim of proven savings. UI requirements: Arc primitives installed through shadcn, selective ReactBits, DotMatrix pending states, Orbkit idle/thinking based on events; retain supplied brand if this is a UI project. No fake data, activity or metrics.`;

export class Engine extends EventEmitter {
  busy = new Set<string>();
  documentation = new Map<string, Promise<void>>();
  timer?: ReturnType<typeof setInterval>;
  constructor(
    public store: Store,
    public runtime: Runtime,
    public dataDir: string,
  ) {
    super();
  }
  changed(type: string, data: any, projectId?: string) {
    this.store.event(type, data, projectId);
    this.emit("change");
  }
  settings() {
    return this.store.get("settings");
  }
  start() {
    this.timer = setInterval(() => this.tick(), 1500);
    this.tick();
  }
  close() {
    clearInterval(this.timer);
    this.runtime.close();
  }
  gate(
    projectId: string,
    title: string,
    detail: string,
    type = "decision",
    taskId?: string,
    extra: any = {},
  ) {
    if (escalationMode(this.store.get(projectId)) === "yolo" && type !== "pr")
      title = title
        .replace("your input", "a decision")
        .replace("your decision", "a decision");
    const existing = this.store
      .all("gate", projectId)
      .find(
        (g) => g.status === "open" && g.taskId === taskId && g.title === title,
      );
    if (existing) return existing;
    const gate = this.store.transaction(() => {
      const gate = this.store.put("gate", {
        projectId,
        taskId,
        title,
        detail,
        type,
        status: "open",
        createdAt: new Date().toISOString(),
        scope: taskId ? "task" : type === "planning" ? "planning" : "project",
        authorRole: "coordinator",
        ...extra,
      });
      if (taskId) this.store.patch(taskId, { status: "blocked" });
      this.store.recordEscalation(gate);
      return gate;
    });
    this.changed("gate-opened", { gateId: gate.id, title }, projectId);
    return gate;
  }
  async run(
    project: RecordData,
    role: string,
    prompt: string,
    schema: any,
    task?: RecordData,
    write = false,
  ) {
    const settings = this.settings(),
      profile =
        role === "orchestrator"
          ? settings.orchestrator
          : role === "judge"
            ? (settings.judge ?? settings.subagent)
            : settings.subagent;
    let agent = this.store
      .all("agent", project.id)
      .find((agent) => agent.role === role);
    if (!agent)
      agent = this.store.put("agent", {
        projectId: project.id,
        role,
        createdAt: new Date().toISOString(),
      });
    const run = this.store.put("run", {
      agentId: agent.id,
      projectId: project.id,
      taskId: task?.id,
      role,
      model: profile.model,
      effort: profile.effort,
      status: "running",
      workflowVersion: "looproom-v1",
      requestedProfile: profile,
      output: "",
      createdAt: new Date().toISOString(),
    });
    this.changed(
      "run-started",
      { runId: run.id, role, taskId: task?.id },
      project.id,
    );
    let lastSave = 0,
      stream = "";
    try {
      const output = await this.runtime.run({
        model: profile.model,
        effort: profile.effort,
        cwd: task?.worktree ?? project.path,
        write,
        prompt: WORKFLOW + "\n\n" + prompt,
        schema: z.toJSONSchema(schema),
        onThread: (threadId, metadata) =>
          this.store.patch(run.id, { threadId, runtime: metadata }),
        onEvent: (method, data) => {
          if (method === "turn-id")
            this.store.patch(run.id, { turnId: data.turnId });
          if (method === "item/agentMessage/delta") {
            stream = (stream + data.delta).slice(-100_000);
            if (Date.now() - lastSave > 350) {
              lastSave = Date.now();
              this.store.patch(run.id, { output: stream });
              this.emit("change");
            }
          }
          if (
            method === "item/started" &&
            ["commandExecution", "fileChange", "webSearch"].includes(
              data.item?.type,
            )
          ) {
            this.store.patch(run.id, { activity: data.item.type });
            this.changed(
              "agent-activity",
              {
                runId: run.id,
                role,
                activity: data.item.type,
                command: data.item.command?.slice(0, 500),
              },
              project.id,
            );
          }
          if (method === "human-gate" && role !== "judge")
            this.gate(
              project.id,
              "Agent needs your decision",
              data.detail,
              "runtime",
              task?.id,
              { authorRole: role, runId: run.id },
            );
        },
      });
      const parsed = schema.parse(JSON.parse(output));
      this.store.patch(run.id, {
        status: "completed",
        output,
        finishedAt: new Date().toISOString(),
      });
      await this.document(
        project.id,
        role + " outcome",
        parsed.summary,
        parsed.sources ?? [],
        run.id,
      );
      this.changed("run-completed", { runId: run.id, role }, project.id);
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const paused = this.store.get(project.id).status !== "running";
      this.store.patch(run.id, {
        status: paused ? "interrupted" : "failed",
        error: message,
        output: stream,
        finishedAt: new Date().toISOString(),
      });
      if (paused && task && role !== "judge")
        this.store.patch(task.id, { status: "ready" });
      else if (
        !paused &&
        role !== "judge" &&
        !this.store
          .all("gate", project.id)
          .some((gate) => gate.status === "open" && gate.taskId === task?.id)
      )
        this.gate(
          project.id,
          role === "orchestrator"
            ? "Planning needs attention"
            : "Run needs attention",
          message,
          "runtime",
          task?.id,
          { authorRole: role, runId: run.id },
        );
      throw error;
    }
  }
  async document(
    projectId: string,
    title: string,
    content: string,
    sources: string[],
    runId: string,
  ) {
    const previous = this.documentation.get(projectId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() =>
        this.writeDocument(projectId, title, content, sources, runId),
      );
    this.documentation.set(projectId, next);
    try {
      await next;
    } finally {
      if (this.documentation.get(projectId) === next)
        this.documentation.delete(projectId);
    }
  }
  async writeDocument(
    projectId: string,
    title: string,
    content: string,
    sources: string[],
    runId: string,
  ) {
    const folder = join(this.dataDir, "wiki", projectId);
    await mkdir(join(folder, "raw"), { recursive: true });
    const rawPath = join(folder, "raw", runId + ".json");
    const raw = JSON.stringify(this.store.get(runId), null, 2);
    await writeFile(rawPath, raw, {
      flag: "wx",
    });
    const manifestPath = join(folder, "raw", "manifest.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8").catch(() => '{"sources":[]}'),
    );
    manifest.sources.push({
      file: runId + ".json",
      sha256: createHash("sha256").update(raw).digest("hex"),
      capturedAt: new Date().toISOString(),
      origin: "codex-run:" + runId,
    });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const record = this.store.memory(projectId, title, content, sources);
    const path = join(folder, record.id + ".md");
    await writeFile(
      path,
      "# " +
        title +
        "\n\n" +
        content +
        "\n\n## Evidence\n\n- [Raw run](raw/" +
        runId +
        ".json)\n" +
        sources.map((source) => "- " + source).join("\n") +
        "\n\nStatus: agent-reported outcome; checks and PR state are recorded separately.\n",
    );
    const pages = this.store.all("memory", projectId);
    await writeFile(
      join(folder, "index.md"),
      "# Project memory\n\n" +
        pages
          .map((page) => "- [" + page.title + "](" + page.id + ".md)")
          .join("\n") +
        "\n",
    );
    const log = join(folder, "log.md");
    const previous = await readFile(log, "utf8").catch(() => "# Memory log\n");
    await writeFile(
      log,
      previous +
        "\n## [" +
        new Date().toISOString() +
        "] outcome | " +
        title +
        "\n\nRun " +
        runId +
        "; page " +
        record.id +
        ".\n",
    );
  }
  async plan(project: RecordData) {
    const memory = this.store
      .all("memory", project.id)
      .slice(-8)
      .map((page) => page.title + ": " + page.content)
      .join("\n");
    const replies = this.store
      .conversation(project.id)
      .filter((message) => message.kind !== "escalation_draft")
      .slice(-12)
      .map((message) => message.role + ": " + message.text)
      .join("\n");
    const plan = await this.run(
      project,
      "orchestrator",
      `Read the repository without modifying it. Goal: ${project.goal}\nScope/exclusions: ${project.constraints}\nConversation:\n${replies}\nPrior memory (unverified until source checked):\n${memory}\nProduce a concise evidence-linked plan and up to six useful bounded tasks, each with acceptance criteria. Dependencies are zero-based task indices and must reflect actual required inputs, not a preferred execution order. Keep independent research, usability and implementation work available while another task waits at a gate. Never bypass a genuine dependency or fabricate a completed prerequisite. The first result is research/planning only. Missing GitHub remote/auth does not block planning or local implementation; gate only publication when it is ready. Empty gate unless a consequential decision cannot be resolved from evidence. Do not generate busywork if the goal is satisfied; use zero tasks and explain why.`,
      Plan,
    );
    validateDependencies(plan.tasks);
    this.store.transaction(() => {
      this.store.put("message", {
        projectId: project.id,
        role: "orchestrator",
        text: plan.summary,
        createdAt: new Date().toISOString(),
      });
      const tasks = plan.tasks.map((task: any) =>
        this.store.put("task", {
          ...task,
          projectId: project.id,
          dependencies: [],
          status: "ready",
          attempt: 0,
          createdAt: new Date().toISOString(),
        }),
      );
      tasks.forEach((task: any, i: number) =>
        this.store.patch(task.id, {
          dependencies: plan.tasks[i].dependencies.map(
            (d: number) => tasks[d].id,
          ),
        }),
      );
      this.store.patch(project.id, {
        planned: true,
        ...(tasks.length || plan.gate ? {} : { status: "idle" }),
      });
    });
    if (plan.gate)
      this.gate(
        project.id,
        "Clarify project direction",
        plan.gate,
        "planning",
        undefined,
        { authorRole: "orchestrator" },
      );
    this.changed(
      "plan-created",
      { summary: plan.summary, taskCount: plan.tasks.length },
      project.id,
    );
  }
  async implement(project: RecordData, task: RecordData) {
    if (!task.worktree) {
      let base = "HEAD";
      if (project.github) {
        await git(project.path, ["fetch", "origin", project.branch]);
        base = "refs/remotes/origin/" + project.branch;
      }
      const tree = await createWorktree(
        project.path,
        this.dataDir,
        task.id,
        base,
      );
      task = this.store.patch(task.id, {
        worktree: tree.path,
        branch: tree.branch,
      });
    }
    if (await prepareDependencies(project.path, task.worktree))
      this.changed(
        "dependencies-prepared",
        { taskId: task.id, method: "matching-lockfile-local-copy" },
        project.id,
      );
    this.store.patch(task.id, { status: "running", attempt: task.attempt + 1 });
    const context = this.store
      .conversation(project.id)
      .filter(
        (message) =>
          message.kind !== "escalation_draft" &&
          (!message.taskId || message.taskId === task.id),
      )
      .slice(-6)
      .map((m) => `${m.role}: ${m.text}`)
      .join("\n");
    const prompt = `Goal: ${project.goal}\nScope: ${project.constraints}\nTask: ${task.title}\n${task.description}\nAcceptance:\n${task.acceptance.join("\n")}\nAttributed conversation: ${context}\nPrevious verification feedback: ${task.feedback ?? "None"}\nWorktree: ${task.worktree}\nImplement and verify only this task, or research without editing if kind is research. Do not commit, change Git metadata, push or merge. Direct network access is disabled. If dependency installation/access is required, report the exact blocker in humanQuestion. Return summary, evidence sources and humanQuestion (empty if none).`;
    const result = await this.run(
      project,
      task.kind === "research" ? "research" : "implementation",
      prompt,
      Result,
      task,
      task.kind !== "research",
    );
    if (this.store.get(project.id).status !== "running") {
      this.store.patch(task.id, { status: "ready" });
      return;
    }
    if (result.humanQuestion) {
      this.gate(
        project.id,
        "Task needs your input",
        result.humanQuestion,
        "decision",
        task.id,
        {
          authorRole: task.kind === "research" ? "research" : "implementation",
        },
      );
      return;
    }
    if (task.kind === "research") {
      this.store.patch(task.id, {
        status: "completed",
        summary: result.summary,
      });
      this.changed("task-completed", { taskId: task.id }, project.id);
      return;
    }
    this.store.patch(task.id, { status: "verifying", summary: result.summary });
    const checks = [];
    for (const command of project.checks) {
      const result = await sandboxCheck(
        this.runtime.binary,
        task.worktree,
        command,
        this.runtime.home,
      );
      checks.push(result);
      this.store.patch(task.id, { checks });
      this.changed(
        "check-completed",
        { taskId: task.id, command, code: result.code },
        project.id,
      );
      if (result.code !== 0) {
        this.repairOrGate(
          project,
          task,
          "Verification failed",
          command + "\n" + result.output.slice(-6000),
          "check",
        );
        return;
      }
    }
    if (!checks.length) {
      this.gate(
        project.id,
        "Set acceptance checks",
        "Add commands in Settings before publishing implementation. No automated check is configured.",
        "check",
        task.id,
      );
      return;
    }
    const review = await this.run(
      project,
      "review",
      `Independently inspect git diff in this worktree for task: ${task.title}. Goal: ${project.goal}. Acceptance: ${task.acceptance.join("; ")}. Coordinator check outcomes: ${JSON.stringify(checks.map((c) => ({ command: c.command, code: c.code })))}. Read actual changed code and look for missing functionality, unsafe behavior, usability/accessibility and unnecessary complexity. Do not edit. Return verdict pass, changes, or gate with evidence.`,
      Review,
      task,
    );
    this.store.patch(task.id, { review });
    if (review.verdict === "changes") {
      this.repairOrGate(
        project,
        task,
        "Review needs changes",
        review.summary,
        "review",
      );
      return;
    }
    if (review.verdict === "gate") {
      this.gate(
        project.id,
        "Review needs your decision",
        review.summary,
        "review",
        task.id,
        { authorRole: "review" },
      );
      return;
    }
    await this.publish(project, this.store.get(task.id));
  }
  repairOrGate(
    project: RecordData,
    task: RecordData,
    title: string,
    detail: string,
    type: string,
  ) {
    const current = this.store.get(task.id);
    if (current.attempt < 3) {
      this.store.patch(task.id, {
        status: "ready",
        feedback: title + "\n" + detail,
      });
      this.changed(
        "repair-requested",
        { taskId: task.id, title, attempt: current.attempt },
        project.id,
      );
    } else
      this.gate(
        project.id,
        title,
        "Three bounded attempts could not resolve this blocker.\n" + detail,
        type,
        task.id,
      );
  }
  async publish(project: RecordData, task: RecordData) {
    if (this.store.get(project.id).status !== "running") {
      this.store.patch(task.id, { status: "ready" });
      return;
    }
    if (!project.github) {
      this.gate(
        project.id,
        "Connect a GitHub remote",
        "Work is verified in " +
          task.worktree +
          ". Add an origin remote to the project repository, then retry.",
        "github",
        task.id,
      );
      return;
    }
    await gh(["auth", "status"]);
    const diff = await git(task.worktree, ["status", "--porcelain"]);
    const untracked = (
      await git(task.worktree, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    const unsafe = untracked.filter(
      (path) =>
        /(^|\/)(node_modules|auth\.json|\.env(?:\.[^/]*)?)(\/|$)/.test(path) ||
        /\.(pem|key)$/.test(path),
    );
    if (unsafe.length) {
      this.gate(
        project.id,
        "Check files before publishing",
        "These untracked paths need exclusion or review: " +
          unsafe.slice(0, 8).join(", "),
        "publication",
        task.id,
      );
      return;
    }
    if (!diff && !task.pr) {
      this.store.patch(task.id, {
        status: "completed",
        summary: task.summary + "\nNo code changes were needed.",
      });
      this.changed("task-completed", { taskId: task.id }, project.id);
      return;
    }
    if (diff) {
      await git(task.worktree, ["add", "--all"]);
      await git(task.worktree, [
        "-c",
        "user.name=Looproom agent",
        "-c",
        "user.email=looproom-agent@localhost",
        "commit",
        "-m",
        task.title,
      ]);
    }
    await git(task.worktree, ["push", "origin", task.branch]);
    const sha = await git(task.worktree, ["rev-parse", "HEAD"]);
    let url = task.pr;
    if (!url) {
      const bodyPath = join(this.dataDir, "pr-" + task.id + ".md");
      await writeFile(
        bodyPath,
        `${task.summary}\n\n## Verification\n${task.checks.map((c: any) => "- " + c.command + ": exit " + c.code).join("\n")}\n\n## Independent review\n${task.review.summary}\n\nHuman approval is required in Looproom for commit ${sha}.\n`,
      );
      url = await gh([
        "pr",
        "create",
        "--repo",
        project.github,
        "--head",
        task.branch,
        "--base",
        project.branch,
        "--title",
        task.title,
        "--body-file",
        bodyPath,
      ]);
    }
    this.store.patch(task.id, { status: "awaiting_human", pr: url, sha });
    this.gate(project.id, "Review pull request", task.summary, "pr", task.id, {
      pr: url,
      sha,
    });
    this.store.patch(task.id, { status: "awaiting_human" });
    this.changed("pr-opened", { taskId: task.id, pr: url, sha }, project.id);
  }
  async prInfo(gateId: string) {
    const gate = this.store.get(gateId);
    if (gate.type !== "pr") throw new Error("This gate is not a pull request.");
    return JSON.parse(
      await gh([
        "pr",
        "view",
        gate.pr,
        "--json",
        "number,url,title,headRefOid,statusCheckRollup,mergeable,state,body,files,baseRefName",
      ]),
    );
  }
  async approve(gateId: string, reviewedSha: string) {
    const gate = this.store.get(gateId);
    if (gate.status !== "open" || gate.type !== "pr")
      throw new Error("This PR approval is no longer open.");
    const info = await this.prInfo(gateId);
    if (reviewedSha !== gate.sha)
      throw new Error(
        "Review the currently displayed revision before approving.",
      );
    if (info.state !== "OPEN") throw new Error("Pull request is not open.");
    checkApproval(
      reviewedSha,
      info.headRefOid,
      info.statusCheckRollup ?? [],
      info.mergeable,
    );
    const project = this.store.get(gate.projectId);
    const result = JSON.parse(
      await gh([
        "api",
        "--method",
        "PUT",
        `repos/${project.github}/pulls/${info.number}/merge`,
        "-f",
        "sha=" + reviewedSha,
        "-f",
        "merge_method=squash",
      ]),
    );
    if (!result.merged)
      throw new Error(result.message ?? "GitHub did not merge this revision.");
    this.store.transaction(() => {
      this.store.patch(gateId, {
        status: "approved",
        reviewedSha,
        mergedSha: result.sha,
        resolvedAt: new Date().toISOString(),
      });
      this.store.patch(gate.taskId, { status: "completed" });
      this.store.recordGateResponse(
        gate,
        `Approved and merged revision ${reviewedSha}.`,
        "human",
        new Date().toISOString(),
      );
      this.store.put("approval", {
        projectId: project.id,
        gateId,
        taskId: gate.taskId,
        reviewedSha,
        mergedSha: result.sha,
        createdAt: new Date().toISOString(),
      });
    });
    this.changed(
      "pr-merged",
      { gateId, reviewedSha, mergedSha: result.sha },
      project.id,
    );
  }
  async resolve(
    gateId: string,
    answer: string,
    retry = true,
    actor: "human" | "judge" = "human",
    runId?: string,
  ) {
    const gate = this.store.get(gateId);
    if (gate.status !== "open") throw new Error("Gate is already resolved.");
    if (actor === "judge" && gate.type === "pr")
      throw new Error("Every PR merge requires human approval.");
    if (gate.type === "github")
      this.store.patch(
        gate.projectId,
        await inspectRepo(this.store.get(gate.projectId).path),
      );
    this.store.transaction(() => {
      const current = this.store.get(gateId),
        project = this.store.get(gate.projectId);
      if (current.status !== "open")
        throw new Error("Gate is already resolved.");
      if (
        actor === "judge" &&
        (escalationMode(project) === "human" || project.status !== "running")
      )
        throw new Error("Automatic judge submission is no longer active.");
      const resolvedAt = new Date().toISOString();
      this.store.patch(gateId, {
        status: "resolved",
        answer,
        resolvedBy: actor,
        resolvedAt,
        awaitingCapability: false,
        ...(actor === "judge" ? { judgeSubmittedAt: resolvedAt } : {}),
      });
      this.store.recordGateResponse(gate, answer, actor, resolvedAt, runId);
      if (gate.taskId) {
        const task = this.store.get(gate.taskId);
        this.store.patch(task.id, {
          status: retry ? "ready" : "cancelled",
          attempt: actor === "human" ? 0 : task.attempt,
          judgeRetries:
            actor === "human" ? 0 : (task.judgeRetries ?? 0) + Number(retry),
          feedback: `${actor === "judge" ? "Judge" : "Human"} answered escalation: ${gate.detail}\n${answer}`,
        });
      } else if (
        !this.store
          .all("task", gate.projectId)
          .some((task) => !["completed", "cancelled"].includes(task.status))
      )
        this.store.patch(gate.projectId, { planned: false });
      this.store.patch(gate.projectId, { status: "running" });
    });
    this.changed("gate-resolved", { gateId, retry, actor }, gate.projectId);
  }
  async recoverEscalation(
    project: RecordData,
    gate: RecordData,
    task: RecordData | undefined,
    assessment: z.infer<typeof Judgment>,
  ) {
    const currentProject = this.store.get(project.id);
    if (
      !task?.worktree ||
      this.store.get(gate.id).status !== "open" ||
      gate.type === "pr" ||
      escalationMode(currentProject) !== "yolo" ||
      currentProject.status !== "running"
    )
      return assessment;
    this.store.patch(gate.id, { judgeRecoveryStatus: "running" });
    this.changed(
      "judge-recovery-started",
      { gateId: gate.id, taskId: task.id },
      project.id,
    );
    try {
      const recovery = await this.run(
        currentProject,
        "judge",
        `YOLO escalation recovery: carry out the recovery in this task's existing worktree, rather than asking a human to perform routine work. Goal: ${project.goal}\nScope: ${project.constraints}\nTask: ${JSON.stringify({ title: task.title, description: task.description, acceptance: task.acceptance, checks: task.checks, feedback: task.feedback })}\nEscalation: ${gate.title}\n${gate.detail}\nAssessment: ${assessment.answer}\nAuthorized coordinator checks: ${JSON.stringify(project.checks ?? [])}\nInspect actual sources and capabilities, then implement the smallest valid repair or use an available alternative. You may edit this task's worktree and execute commands under its existing workspace permissions. Keep acceptance checks, scope, credential isolation and sandbox protections intact. Never commit, change Git metadata, publish or merge a PR. Never invent credentials or claim an unavailable capability was granted. If no repair is possible, return wait with the specific observed condition; the coordinator will recheck automatically. If your verified repair lets the worker continue, return retry with what changed, actual evidence and next steps. Skip is only for work demonstrably unnecessary to the goal, never a substitute for completing required work. Distinguish executed results from proposed checks. Return answer, action, summary and evidence sources.`,
        Judgment,
        task,
        true,
      );
      this.store.patch(gate.id, { judgeRecoveryStatus: "completed" });
      this.changed(
        "judge-recovery-completed",
        { gateId: gate.id, action: recovery.action },
        project.id,
      );
      return {
        ...recovery,
        summary: assessment.summary + "\n" + recovery.summary,
        sources: [...new Set([...assessment.sources, ...recovery.sources])],
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.store.patch(gate.id, {
        judgeRecoveryStatus: "failed",
        judgeRecoveryError: detail,
      });
      return {
        ...assessment,
        action: "wait" as const,
        answer: (
          assessment.answer.slice(0, 4200) +
          "\nAutomatic recovery could not complete: " +
          detail.slice(0, 1200) +
          "\nLooproom will recheck this blocker automatically."
        ).slice(0, 6000),
      };
    }
  }
  async judge(project: RecordData, gate: RecordData) {
    if (gate.status !== "open") return;
    const task = gate.taskId ? this.store.get(gate.taskId) : undefined;
    if (
      escalationMode(project) === "yolo" &&
      gate.awaitingCapability &&
      gate.judgeNextAttemptAt &&
      gate.judgeNextAttemptAt <= Date.now() &&
      task
    )
      this.store.patch(task.id, { judgeRetries: 0 });
    this.store.patch(gate.id, {
      judgeStatus: "running",
      judgeError: null,
      judgeRecoveryStatus: null,
      judgeRecoveryError: null,
      judgeAttempts: (gate.judgeAttempts ?? 0) + 1,
    });
    this.changed("judge-started", { gateId: gate.id }, project.id);
    try {
      const context = this.store
        .conversation(project.id)
        .filter((message) => !message.taskId || message.taskId === gate.taskId)
        .slice(-10);
      const relatedTasks = this.store.all("task", project.id).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        dependencies: t.dependencies,
        ...(t.id === task?.id
          ? {
              description: t.description,
              acceptance: t.acceptance,
              feedback: t.feedback,
              checks: t.checks,
              judgeRetries: t.judgeRetries,
            }
          : {}),
      }));
      const origin =
        (gate.originRunId ?? gate.runId)
          ? this.store.get(gate.originRunId ?? gate.runId)
          : undefined;
      let result = await this.run(
        project,
        "judge",
        `You are Looproom's independent escalation judge. Craft a precise, useful response to THIS escalation, ready to send to its originating agent. Current mode: ${escalationMode(project)}. Human mode prepares a draft; bypass submits retry/skip; YOLO submits every non-PR response. Never impersonate a human.
Goal: ${project.goal}
Scope/exclusions: ${project.constraints}
Repository: ${project.path}
Authorized checks: ${JSON.stringify(project.checks ?? [])}
Escalation: ${JSON.stringify({ id: gate.id, title: gate.title, detail: gate.detail, type: gate.type, scope: gate.scope, authorRole: gate.authorRole })}
Task and dependency frontier: ${JSON.stringify(relatedTasks)}
Originating run: ${JSON.stringify(origin ? { role: origin.role, output: String(origin.output ?? "").slice(-16000), error: origin.error } : null)}
Relevant conversation, including earlier responses: ${JSON.stringify(context)}
Read actual repository evidence; check referenced files and failures rather than treating previous agent claims as facts. Answer the exact question first, choose a concrete course of action, then give implementable next steps and the checks that establish success. Cite relevant paths/sources and state any assumption or unresolved fact. Prefer existing components and the smallest useful change. Avoid generic reassurance, repeated escalation text, vague instructions to investigate, invented preferences or commands already known to fail. Before returning, check that your response directly answers the question, respects scope and acceptance, distinguishes observed from proposed work, and gives the recipient enough information to act.
Action retry: your specific decision permits continuing within existing capabilities. If an attempt failed, identify a different evidence-supported approach; never repeat an unchanged environment denial. Action skip: task is demonstrably unnecessary, with an explicit reason; inability alone is not a reason to abandon required work. Action wait: no valid route exists because a concrete capability or fact is missing; give the exact missing condition, evidence and what would allow resumption. In YOLO this is a submitted machine blocker, not a request for human approval; other independent work continues. Never claim to have fixed files, run checks, installed packages, granted permissions or changed credentials. A read-only reply cannot grant spawn, network or filesystem access. Do not change scope, acceptance checks or sandbox permissions. For a PR escalation, produce a sourced review note only (action wait); every merge requires the human's approval of that exact revision. Never authorize or merge a PR`,
        Judgment,
        task,
        false,
      );
      if (
        result.action === "wait" &&
        gate.type !== "pr" &&
        escalationMode(this.store.get(project.id)) === "yolo"
      )
        result = await this.recoverEscalation(project, gate, task, result);
      const run = this.store
        .all("run", project.id)
        .filter((run) => run.role === "judge")
        .at(-1)!;
      const current = this.store.get(gate.id),
        currentProject = this.store.get(project.id);
      if (current.status !== "open") return;
      let action = gate.type === "pr" ? "wait" : result.action,
        answer = result.answer;
      if (
        action === "retry" &&
        task &&
        (this.store.get(task.id).judgeRetries ?? 0) >= 3
      ) {
        action = "wait";
        answer =
          answer.slice(0, 5600) +
          "\nThree judge retries did not clear this task. This task remains blocked until its failed prerequisite or unavailable capability changes; independent tasks may continue. Do not repeat the same attempt.";
      }
      this.store.transaction(() => {
        this.store.patch(gate.id, {
          judgeStatus: "answered",
          judgeAnswer: answer,
          judgeAction: action,
          judgeRunId: run.id,
          judgeSummary: result.summary,
          judgeSources: result.sources,
          judgeFailures: 0,
          judgeNextAttemptAt: null,
        });
        this.store.recordGateResponse(
          gate,
          answer,
          "judge",
          new Date().toISOString(),
          run.id,
          "escalation_draft",
        );
      });
      if (
        gate.type !== "pr" &&
        action !== "wait" &&
        escalationMode(currentProject) !== "human" &&
        currentProject.status === "running"
      )
        await this.resolve(
          gate.id,
          answer,
          action === "retry",
          "judge",
          run.id,
        );
      if (
        gate.type !== "pr" &&
        action === "wait" &&
        escalationMode(currentProject) === "yolo" &&
        currentProject.status === "running"
      ) {
        this.store.transaction(() => {
          const latestProject = this.store.get(project.id),
            latestGate = this.store.get(gate.id);
          if (
            latestGate.status !== "open" ||
            escalationMode(latestProject) !== "yolo" ||
            latestProject.status !== "running"
          )
            return;
          const submittedAt = new Date().toISOString();
          this.store.patch(gate.id, {
            judgeSubmittedAt: submittedAt,
            awaitingCapability: true,
            judgeRechecks: (latestGate.judgeRechecks ?? 0) + 1,
            judgeNextAttemptAt:
              Date.now() +
              Math.min(
                30 * 60_000,
                5 * 60_000 * 2 ** (latestGate.judgeRechecks ?? 0),
              ),
            answer,
            resolvedBy: "judge",
          });
          this.store.recordGateResponse(
            gate,
            answer,
            "judge",
            submittedAt,
            run.id,
          );
          if (task)
            this.store.patch(task.id, {
              status: "blocked",
              feedback: `Judge answered escalation: ${gate.detail}\n${answer}`,
            });
        });
      }
      this.changed(
        "judge-answered",
        {
          gateId: gate.id,
          action,
          applied: Boolean(this.store.get(gate.id).judgeSubmittedAt),
        },
        project.id,
      );
    } catch (error) {
      const current = this.store.get(gate.id);
      if (current.status === "open")
        this.store.patch(gate.id, {
          judgeStatus:
            escalationMode(this.store.get(project.id)) === "yolo" &&
            (current.judgeFailures ?? 0) < 2
              ? "pending"
              : "failed",
          judgeFailures: (current.judgeFailures ?? 0) + 1,
          judgeNextAttemptAt:
            Date.now() +
            ((current.judgeFailures ?? 0) >= 2
              ? 30 * 60_000
              : 15_000 * 2 ** (current.judgeFailures ?? 0)),
          judgeError: error instanceof Error ? error.message : String(error),
        });
      this.changed("judge-failed", { gateId: gate.id }, project.id);
    }
  }
  dispatch(
    key: string,
    project: RecordData,
    work: () => Promise<void>,
    taskId?: string,
  ) {
    this.busy.add(key);
    Promise.resolve()
      .then(work)
      .catch((error) => {
        if (
          this.store.get(project.id).status === "running" &&
          !this.store
            .all("gate", project.id)
            .some((gate) => gate.status === "open" && gate.taskId === taskId)
        )
          this.gate(
            project.id,
            "Work needs attention",
            error instanceof Error ? error.message : String(error),
            "runtime",
            taskId,
          );
      })
      .finally(() => {
        this.busy.delete(key);
        this.emit("change");
      });
  }
  tick() {
    const limit = this.settings().concurrency;
    for (const project of this.store.all("project")) {
      if (project.status !== "running") continue;
      const gates = this.store
        .all("gate", project.id)
        .filter((gate) => gate.status === "open");
      const judgeKey = "judge:" + project.id;
      if (this.busy.size < limit && !this.busy.has(judgeKey)) {
        const candidate = gates.find((gate) => {
          if (gate.judgeStatus === "running") return false;
          if (gate.judgeNextAttemptAt && gate.judgeNextAttemptAt > Date.now())
            return false;
          if (!["answered", "failed"].includes(gate.judgeStatus)) return true;
          const mode = escalationMode(project);
          if (mode === "yolo") {
            if (gate.judgeStatus === "failed") return true;
            return (
              gate.type !== "pr" &&
              (!gate.judgeSubmittedAt || gate.awaitingCapability)
            );
          }
          return (
            mode === "bypass" &&
            gate.type !== "pr" &&
            gate.judgeStatus === "answered" &&
            !gate.judgeSubmittedAt &&
            gate.judgeAction !== "wait"
          );
        });
        if (candidate)
          this.dispatch(
            judgeKey,
            project,
            () => this.judge(project, candidate),
            candidate.taskId,
          );
      }
      if (
        this.busy.size >= limit ||
        gates.some(
          (gate) =>
            (gate.scope ?? (gate.taskId ? "task" : "project")) === "project",
        )
      )
        continue;
      const planKey = "plan:" + project.id;
      if (!project.planned) {
        if (
          !gates.length &&
          !this.busy.has(planKey) &&
          !this.store
            .all("run", project.id)
            .some((run) => run.status === "running" && run.role !== "judge")
        )
          this.dispatch(planKey, project, () => this.plan(project));
        continue;
      }
      const tasks = this.store.all("task", project.id);
      for (const task of tasks) {
        if (this.busy.size >= limit) break;
        const key = "task:" + task.id;
        if (
          task.status !== "ready" ||
          this.busy.has(key) ||
          this.store
            .all("run", project.id)
            .some(
              (run) =>
                run.taskId === task.id &&
                run.role === "judge" &&
                run.status === "running",
            ) ||
          gates.some((gate) => gate.taskId === task.id)
        )
          continue;
        const parents = task.dependencies.map((id: string) =>
          this.store.get(id),
        );
        const cancelled = parents.find(
          (parent: RecordData) => parent.status === "cancelled",
        );
        if (cancelled) {
          this.gate(
            project.id,
            "A prerequisite was skipped",
            "Decide whether to revise or skip this dependent task. Prerequisite: " +
              cancelled.title,
            "dependency",
            task.id,
          );
          continue;
        }
        if (
          parents.every((parent: RecordData) => parent.status === "completed")
        )
          this.dispatch(
            key,
            project,
            () => this.implement(project, task),
            task.id,
          );
      }
      if (
        tasks.length &&
        !gates.length &&
        tasks.every((task) => ["completed", "cancelled"].includes(task.status))
      ) {
        this.store.patch(project.id, { planned: false });
        this.changed("cycle-completed", {}, project.id);
      }
    }
  }
}
