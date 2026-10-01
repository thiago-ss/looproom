import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import type { Runtime } from "./runtime.ts";
async function fixture(run?: (options: any) => Promise<string>) {
  const dir = await mkdtemp(join(tmpdir(), "looproom-escalation-"));
  const store = new Store(join(dir, "db"));
  const runtime = Object.assign(new EventEmitter(), { run, close() {} });
  const engine = new Engine(store, runtime as unknown as Runtime, dir);
  store.put(
    "settings",
    {
      orchestrator: { model: "gpt-6.1-sol", effort: "high" },
      subagent: { model: "gpt-6-sol", effort: "medium" },
      judge: { model: "gpt-6-sol", effort: "medium" },
      concurrency: 2,
    },
    "settings",
  );
  const project = store.put("project", {
    path: dir,
    goal: "Useful scoped work",
    constraints: "",
    status: "running",
    planned: true,
    bypass: true,
  });
  return {
    store,
    engine,
    project,
    async close() {
      engine.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
test("blocked and dependent tasks wait while two independent tasks dispatch without duplicates", async () => {
  const f = await fixture();
  const held: (() => void)[] = [],
    started: string[] = [];
  try {
    const blocked = f.store.put("task", {
      projectId: f.project.id,
      status: "ready",
      dependencies: [],
      title: "Needs context",
    });
    f.engine.gate(f.project.id, "Choose", "A decision", "decision", blocked.id);
    f.store.put("task", {
      projectId: f.project.id,
      status: "ready",
      dependencies: [blocked.id],
      title: "Dependent",
    });
    const free = ["Independent one", "Independent two"].map((title) =>
      f.store.put("task", {
        projectId: f.project.id,
        status: "ready",
        dependencies: [],
        title,
      }),
    );
    f.engine.implement = async (_project, task) => {
      started.push(task.id);
      f.store.patch(task.id, { status: "running" });
      await new Promise<void>((resolve) => held.push(resolve));
      f.store.patch(task.id, { status: "completed" });
    };
    // Avoid a judge during this scheduler test.
    f.store.patch(f.project.id, { bypass: false });
    for (const gate of f.store.all("gate"))
      f.store.patch(gate.id, { judgeStatus: "answered" });
    f.engine.tick();
    f.engine.tick();
    await settle();
    assert.deepEqual(
      started,
      free.map((task) => task.id),
    );
    assert.equal(f.engine.busy.size, 2);
    assert.equal(f.store.get(blocked.id).status, "blocked");
    held.forEach((resolve) => resolve());
    await settle();
    assert.equal(f.engine.busy.size, 0);
  } finally {
    await f.close();
  }
});
test("planning gates permit existing independent contracts; project scope stops dispatch", async () => {
  const f = await fixture();
  try {
    f.store.patch(f.project.id, { bypass: false });
    const task = f.store.put("task", {
      projectId: f.project.id,
      status: "ready",
      dependencies: [],
      title: "Already scoped",
    });
    const gate = f.engine.gate(
      f.project.id,
      "Direction",
      "Planning question",
      "planning",
    );
    f.store.patch(gate.id, { judgeStatus: "answered" });
    const started: string[] = [];
    f.engine.implement = async (_p, t) => {
      started.push(t.id);
      f.store.patch(t.id, { status: "completed" });
    };
    f.engine.tick();
    await settle();
    assert.deepEqual(started, [task.id]);
    f.store.patch(task.id, { status: "ready" });
    f.store.patch(gate.id, { scope: "project" });
    f.engine.tick();
    await settle();
    assert.deepEqual(started, [task.id]);
  } finally {
    await f.close();
  }
});
test("judge replies are read-only, attributed, bounded, and never authorize PRs", async () => {
  const calls: any[] = [];
  const f = await fixture(async (options) => {
    calls.push(options);
    options.onThread("fixture");
    return JSON.stringify({
      action: "retry",
      answer: "Use the existing Select component.",
      summary: "Resolved a routine component choice.",
      sources: ["src/components/ui/select.tsx"],
    });
  });
  try {
    const task = f.store.put("task", {
      projectId: f.project.id,
      status: "ready",
      dependencies: [],
      attempt: 2,
      title: "Choose control",
    });
    const gate = f.engine.gate(
      f.project.id,
      "Control question",
      "Which existing control?",
      "decision",
      task.id,
      { authorRole: "implementation" },
    );
    await f.engine.judge(f.project, gate);
    assert.equal(calls[0].write, false);
    assert.equal(calls[0].model, "gpt-6-sol");
    assert.equal(calls[0].effort, "medium");
    assert.equal(f.store.get(gate.id).resolvedBy, "judge");
    assert.equal(f.store.get(task.id).attempt, 2);
    assert.equal(f.store.get(task.id).judgeRetries, 1);
    const chat = f.store.conversation(f.project.id);
    assert.equal(chat[0].kind, "escalation");
    assert.equal(chat[0].role, "implementation");
    assert.equal(chat[1].kind, "escalation_response");
    assert.equal(chat[1].role, "judge");
    assert.equal(chat[1].gateId, gate.id);
    assert.match(f.store.get(task.id).feedback, /Judge answered/);
    const pr = f.engine.gate(
      f.project.id,
      "PR",
      "Review commit",
      "pr",
      task.id,
    );
    await assert.rejects(
      f.engine.resolve(pr.id, "Approved", true, "judge"),
      /human approval/,
    );
    await f.engine.judge(f.project, pr);
    assert.equal(calls.length, 2);
    assert.equal(f.store.get(pr.id).status, "open");
    assert.equal(f.store.get(pr.id).judgeSubmittedAt, undefined);
    assert.equal(f.store.all("approval").length, 0);
    f.store.patch(pr.id, { status: "resolved" });
    f.store.patch(task.id, { judgeRetries: 3 });
    const recurring = f.engine.gate(
      f.project.id,
      "Recurring",
      "Same unresolved issue",
      "decision",
      task.id,
    );
    await f.engine.judge(f.project, recurring);
    assert.equal(f.store.get(recurring.id).status, "open");
    assert.equal(f.store.get(recurring.id).judgeAction, "wait");
    assert.equal(f.store.get(task.id).status, "blocked");
  } finally {
    await f.close();
  }
});
test("turning bypass off during judgment preserves an attributed proposal without resolving the gate", async () => {
  let finish!: (result: string) => void;
  const f = await fixture((options) => {
    options.onThread("fixture");
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  try {
    const gate = f.engine.gate(
      f.project.id,
      "Planning",
      "Choose one",
      "planning",
    );
    const judging = f.engine.judge(f.project, gate);
    await settle();
    f.store.patch(f.project.id, { bypass: false });
    finish(
      JSON.stringify({
        action: "retry",
        answer: "A sourced option.",
        summary: "Proposed choice.",
        sources: [],
      }),
    );
    await judging;
    assert.equal(f.store.get(gate.id).status, "open");
    assert.equal(f.store.conversation(f.project.id).at(-1)?.role, "judge");
    assert.equal(f.store.all("approval").length, 0);
  } finally {
    await f.close();
  }
});
test("legacy escalation history migrates once, links the human reply, and survives recovery", async () => {
  const f = await fixture();
  try {
    const gate = f.store.put("gate", {
      projectId: f.project.id,
      title: "Question",
      detail: "Evidence?",
      type: "decision",
      status: "resolved",
      answer: "Use this source",
      createdAt: "2026-09-30T10:00:00.000Z",
      resolvedAt: "2026-09-30T10:01:00.000Z",
    });
    const message = f.store.put("message", {
      projectId: f.project.id,
      role: "human",
      text: gate.answer,
      createdAt: gate.resolvedAt,
    });
    f.store.syncConversation();
    f.store.syncConversation();
    assert.equal(f.store.conversation(f.project.id).length, 2);
    assert.equal(f.store.get(message.id).gateId, gate.id);
    assert.equal(f.store.conversation(f.project.id)[0].kind, "escalation");
    const waiting = f.engine.gate(
      f.project.id,
      "Judge waiting",
      "A question",
      "planning",
    );
    f.store.patch(waiting.id, { judgeStatus: "running" });
    f.store.put("run", {
      projectId: f.project.id,
      role: "judge",
      status: "running",
    });
    f.store.recover();
    assert.equal(f.store.get(f.project.id).status, "running");
    assert.equal(f.store.get(waiting.id).judgeStatus, "failed");
    assert.equal(f.store.all("gate").length, 2);
  } finally {
    await f.close();
  }
});

test("human mode prepares a gate-specific draft without sending it or releasing the task", async () => {
  let prompt = "";
  const f = await fixture(async (options) => {
    prompt = options.prompt;
    options.onThread("fixture");
    return JSON.stringify({
      action: "retry",
      answer: "Use Arc Select; verify keyboard navigation.",
      summary: "Existing control resolves the question.",
      sources: ["src/components/arc/select/select.tsx"],
    });
  });
  try {
    f.store.patch(f.project.id, { escalationMode: "human" });
    const task = f.store.put("task", {
      projectId: f.project.id,
      title: "Choose selector",
      acceptance: ["Keyboard support"],
      status: "ready",
      dependencies: [],
      feedback: "Native selector failed",
    });
    const gate = f.engine.gate(
      f.project.id,
      "Which selector?",
      "Replace the native model selector",
      "decision",
      task.id,
    );
    await f.engine.judge(f.store.get(f.project.id), gate);
    assert.match(prompt, /Replace the native model selector/);
    assert.match(prompt, /Keyboard support/);
    assert.match(prompt, /Native selector failed/);
    assert.equal(f.store.get(gate.id).status, "open");
    assert.equal(f.store.get(gate.id).judgeSubmittedAt, undefined);
    assert.deepEqual(f.store.get(gate.id).judgeSources, [
      "src/components/arc/select/select.tsx",
    ]);
    assert.equal(
      f.store.conversation(f.project.id).at(-1)?.kind,
      "escalation_draft",
    );
    assert.equal(f.store.get(task.id).status, "blocked");
  } finally {
    await f.close();
  }
});

test("YOLO submits retry and skip responses once, with durable attribution and no merge authority", async () => {
  let action = "retry";
  const f = await fixture(async (options) => {
    options.onThread("fixture");
    return JSON.stringify({
      action,
      answer:
        action === "retry"
          ? "Use the existing Arc control."
          : "Remove the duplicate research task; its acceptance is already satisfied by task evidence.",
      summary: "Specific decision.",
      sources: [],
    });
  });
  try {
    f.store.patch(f.project.id, { escalationMode: "yolo", bypass: false });
    const task = f.store.put("task", {
      projectId: f.project.id,
      title: "Bounded task",
      status: "ready",
      dependencies: [],
    });
    const gate = f.engine.gate(
      f.project.id,
      "Control",
      "Which component?",
      "decision",
      task.id,
    );
    assert.equal(
      f.engine.gate(
        f.project.id,
        "Control",
        "Which component?",
        "decision",
        task.id,
      ).id,
      gate.id,
    );
    await f.engine.judge(f.store.get(f.project.id), gate);
    await f.engine.judge(f.store.get(f.project.id), f.store.get(gate.id));
    assert.equal(f.store.get(gate.id).resolvedBy, "judge");
    assert.ok(f.store.get(gate.id).judgeSubmittedAt);
    assert.equal(f.store.get(task.id).status, "ready");
    assert.equal(f.store.get(task.id).judgeRetries, 1);
    assert.equal(
      f.store
        .conversation(f.project.id)
        .filter((m) => m.gateId === gate.id && m.kind === "escalation_response")
        .length,
      1,
    );
    action = "skip";
    const duplicate = f.engine.gate(
      f.project.id,
      "Duplicate",
      "Is this research redundant?",
      "decision",
      task.id,
    );
    await f.engine.judge(f.store.get(f.project.id), duplicate);
    assert.equal(f.store.get(task.id).status, "cancelled");
    const pr = f.engine.gate(
      f.project.id,
      "PR approval",
      "Exact revision",
      "pr",
      task.id,
    );
    await f.engine.judge(f.store.get(f.project.id), pr);
    assert.equal(f.store.get(pr.id).status, "open");
    assert.equal(f.store.get(pr.id).judgeAction, "wait");
    assert.equal(f.store.get(pr.id).judgeSubmittedAt, undefined);
    assert.equal(
      f.store.conversation(f.project.id).at(-1)?.kind,
      "escalation_draft",
    );
    await assert.rejects(
      f.engine.resolve(pr.id, "Merge", true, "judge"),
      /human approval/,
    );
    assert.equal(f.store.all("approval").length, 0);
  } finally {
    await f.close();
  }
});

test("YOLO sends an honest capability blocker while independent work continues and dependencies wait", async () => {
  const f = await fixture(async (options) => {
    options.onThread("fixture");
    return JSON.stringify({
      action: "wait",
      answer:
        "The recorded process spawn denial prevents verification. Resume when that capability is available; continue independent source research.",
      summary: "Unavailable verification capability.",
      sources: ["recorded checks"],
    });
  });
  try {
    f.store.patch(f.project.id, { escalationMode: "yolo" });
    const task = f.store.put("task", {
      projectId: f.project.id,
      status: "ready",
      dependencies: [],
      title: "Verify",
    });
    f.store.put("task", {
      projectId: f.project.id,
      status: "ready",
      dependencies: [task.id],
      title: "Depends on verification",
    });
    const independent = f.store.put("task", {
      projectId: f.project.id,
      status: "ready",
      dependencies: [],
      title: "Independent research",
    });
    const gate = f.engine.gate(
      f.project.id,
      "Spawn denied",
      "EPERM",
      "verification",
      task.id,
    );
    await f.engine.judge(f.store.get(f.project.id), gate);
    assert.equal(f.store.get(gate.id).status, "open");
    assert.equal(f.store.get(gate.id).awaitingCapability, true);
    assert.ok(f.store.get(gate.id).judgeSubmittedAt);
    assert.equal(
      f.store.conversation(f.project.id).at(-1)?.kind,
      "escalation_response",
    );
    const started: string[] = [];
    f.engine.implement = async (_p, t) => {
      started.push(t.id);
      f.store.patch(t.id, { status: "completed" });
    };
    f.engine.tick();
    await settle();
    assert.deepEqual(started, [independent.id]);
    assert.equal(f.store.get(task.id).status, "blocked");
    f.store.recover();
    f.store.syncConversation();
    assert.equal(f.store.get(gate.id).awaitingCapability, true);
    assert.equal(
      f.store
        .conversation(f.project.id)
        .filter((m) => m.kind === "escalation_response").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("pausing or switching YOLO to human during judgment prevents automatic submission", async () => {
  for (const change of [{ escalationMode: "human" }, { status: "paused" }]) {
    let finish!: (result: string) => void;
    const f = await fixture((options) => {
      options.onThread("fixture");
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    try {
      f.store.patch(f.project.id, { escalationMode: "yolo" });
      const gate = f.engine.gate(
        f.project.id,
        "Choice",
        "Scoped question",
        "planning",
      );
      const judging = f.engine.judge(f.store.get(f.project.id), gate);
      await settle();
      f.store.patch(f.project.id, change);
      finish(
        JSON.stringify({
          action: "retry",
          answer: "Choose the existing approach.",
          summary: "Decision",
          sources: [],
        }),
      );
      await judging;
      assert.equal(f.store.get(gate.id).status, "open");
      assert.equal(f.store.get(gate.id).judgeSubmittedAt, undefined);
      assert.equal(
        f.store.conversation(f.project.id).at(-1)?.kind,
        "escalation_draft",
      );
    } finally {
      await f.close();
    }
  }
});

test("YOLO judge transport failures retry with backoff and stop after three attempts without opening human gates", async () => {
  const f = await fixture(async () => {
    throw new Error("Transport unavailable");
  });
  try {
    f.store.patch(f.project.id, { escalationMode: "yolo" });
    const gate = f.engine.gate(f.project.id, "Choice", "Question", "planning");
    for (let attempt = 1; attempt <= 3; attempt++) {
      await f.engine.judge(f.store.get(f.project.id), f.store.get(gate.id));
      const current = f.store.get(gate.id);
      assert.equal(current.judgeAttempts, attempt);
      assert.equal(current.judgeStatus, attempt < 3 ? "pending" : "failed");
      assert.ok(current.judgeNextAttemptAt > Date.now());
      assert.equal(current.judgeSubmittedAt, undefined);
    }
    assert.equal(f.store.all("gate").length, 1);
    assert.equal(f.store.all("approval").length, 0);
  } finally {
    await f.close();
  }
});

test("YOLO re-assesses an unsent durable draft after restart and preserves PR drafts", async () => {
  const f = await fixture();
  try {
    f.store.patch(f.project.id, { escalationMode: "yolo" });
    const gate = f.engine.gate(
      f.project.id,
      "Choice",
      "Unsubmitted decision",
      "planning",
    );
    f.store.patch(gate.id, { judgeStatus: "answered", judgeAction: "retry" });
    const pr = f.engine.gate(f.project.id, "PR", "Review revision", "pr");
    f.store.patch(pr.id, { judgeStatus: "answered", judgeAction: "wait" });
    f.store.recover();
    const started: string[] = [];
    f.engine.judge = async (_project, candidate) => {
      started.push(candidate.id);
      f.store.patch(candidate.id, {
        judgeSubmittedAt: new Date().toISOString(),
        awaitingCapability: true,
      });
    };
    f.engine.tick();
    f.engine.tick();
    await settle();
    assert.deepEqual(started, [gate.id]);
    assert.equal(f.store.get(pr.id).judgeSubmittedAt, undefined);
  } finally {
    await f.close();
  }
});
