import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Store, type RecordData } from "./store.ts";
import { Runtime } from "./runtime.ts";
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
const WORKFLOW = `Use Looproom's versioned adaptation of Matt Pocock's Wayfinder -> primary-source research -> spec/tickets -> implement. Routine questions are answered from repository evidence with assumptions recorded. Never impersonate a human in original HITL steps. Ponytail: reuse existing behavior, standard library and native features before adding code/dependencies. Preserve accessibility and validation. Cite repo files and primary sources. Karpathy LLM Wiki: source-backed outcomes, explicit contradictions; your own previous output is not independent evidence. Autoresearch: bounded changes, frozen acceptance criteria, measurable baseline/candidate, keep or discard; never change the evaluator to improve the score. Jev retrieval is a candidate to compare against FTS5, not a claim of proven savings. UI requirements: shadcn foundation, selective ReactBits, DotMatrix pending states, Orbkit idle/thinking based on events; retain supplied brand if this is a UI project. No fake data, activity or metrics.`;

export class Engine extends EventEmitter {
  busy = new Set<string>();
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
    const existing = this.store
      .all("gate", projectId)
      .find(
        (g) => g.status === "open" && g.taskId === taskId && g.title === title,
      );
    if (existing) return existing;
    const gate = this.store.put("gate", {
      projectId,
      taskId,
      title,
      detail,
      type,
      status: "open",
      createdAt: new Date().toISOString(),
      ...extra,
    });
    if (taskId) this.store.patch(taskId, { status: "blocked" });
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
        role === "orchestrator" ? settings.orchestrator : settings.subagent;
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
          if (method === "human-gate")
            this.gate(
              project.id,
              "Agent needs your decision",
              data.detail,
              "runtime",
              task?.id,
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
      if (paused && task) this.store.patch(task.id, { status: "ready" });
      else if (
        !paused &&
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
      .all("message", project.id)
      .slice(-12)
      .map((message) => message.role + ": " + message.text)
      .join("\n");
    const plan = await this.run(
      project,
      "orchestrator",
      `Read the repository without modifying it. Goal: ${project.goal}\nScope/exclusions: ${project.constraints}\nConversation:\n${replies}\nPrior memory (unverified until source checked):\n${memory}\nProduce a concise evidence-linked plan and up to six useful bounded tasks, each with acceptance criteria. Dependencies are zero-based task indices. The first result is research/planning only. Empty gate unless a consequential decision cannot be resolved from evidence. Do not generate busywork if the goal is satisfied; use zero tasks and explain why.`,
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
        ...(tasks.length ? {} : { status: "idle" }),
      });
    });
    if (plan.gate)
      this.gate(project.id, "Clarify project direction", plan.gate, "planning");
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
    this.store.patch(task.id, { status: "running", attempt: task.attempt + 1 });
    const context = this.store
      .all("message", project.id)
      .slice(-6)
      .map((m) => m.text)
      .join("\n");
    const prompt = `Goal: ${project.goal}\nScope: ${project.constraints}\nTask: ${task.title}\n${task.description}\nAcceptance:\n${task.acceptance.join("\n")}\nHuman context: ${context}\nPrevious verification feedback: ${task.feedback ?? "None"}\nWorktree: ${task.worktree}\nImplement and verify only this task, or research without editing if kind is research. Do not commit, change Git metadata, push or merge. Direct network access is disabled. If dependency installation/access is required, report the exact blocker in humanQuestion. Return summary, evidence sources and humanQuestion (empty if none).`;
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
  async resolve(gateId: string, answer: string, retry = true) {
    const gate = this.store.get(gateId);
    if (gate.status !== "open") throw new Error("Gate is already resolved.");
    if (gate.type === "github")
      this.store.patch(
        gate.projectId,
        await inspectRepo(this.store.get(gate.projectId).path),
      );
    this.store.transaction(() => {
      this.store.patch(gateId, {
        status: "resolved",
        answer,
        resolvedAt: new Date().toISOString(),
      });
      this.store.put("message", {
        projectId: gate.projectId,
        role: "human",
        text: answer,
        createdAt: new Date().toISOString(),
      });
      if (gate.taskId)
        this.store.patch(gate.taskId, {
          status: retry ? "ready" : "cancelled",
          attempt: 0,
        });
      else this.store.patch(gate.projectId, { planned: false });
      this.store.patch(gate.projectId, { status: "running" });
    });
    this.changed("gate-resolved", { gateId, retry }, gate.projectId);
  }
  tick() {
    const limit = this.settings().concurrency;
    for (const project of this.store.all("project")) {
      if (
        this.busy.size >= limit ||
        this.busy.has(project.id) ||
        project.status !== "running"
      )
        continue;
      const gates = this.store
        .all("gate", project.id)
        .filter((g) => g.status === "open");
      if (gates.some((g) => !g.taskId)) continue;
      const tasks = this.store.all("task", project.id);
      for (const task of tasks.filter((task) => task.status === "ready")) {
        const cancelled = task.dependencies
          .map((id: string) => this.store.get(id))
          .find((parent: RecordData) => parent.status === "cancelled");
        if (cancelled)
          this.gate(
            project.id,
            "A prerequisite was skipped",
            "Decide whether to revise or skip this dependent task. Prerequisite: " +
              cancelled.title,
            "dependency",
            task.id,
          );
      }
      const ready = tasks.find(
        (task) =>
          task.status === "ready" &&
          this.store.get(task.id).status === "ready" &&
          !gates.some((g) => g.taskId === task.id) &&
          task.dependencies.every(
            (id: string) => this.store.get(id).status === "completed",
          ),
      );
      if (project.planned && !ready) {
        if (
          tasks.length &&
          tasks.every((task) =>
            ["completed", "cancelled"].includes(task.status),
          )
        ) {
          this.store.patch(project.id, { planned: false });
          this.changed("cycle-completed", {}, project.id);
        }
        continue;
      }
      this.busy.add(project.id);
      (project.planned ? this.implement(project, ready!) : this.plan(project))
        .catch((error) => {
          if (
            this.store.get(project.id).status === "running" &&
            !this.store
              .all("gate", project.id)
              .some(
                (gate) => gate.status === "open" && gate.taskId === ready?.id,
              )
          )
            this.gate(
              project.id,
              "Work needs attention",
              error instanceof Error ? error.message : String(error),
              "runtime",
              ready?.id,
            );
        })
        .finally(() => {
          this.busy.delete(project.id);
          this.emit("change");
        });
    }
  }
}
