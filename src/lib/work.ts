export type FrontierTask = {
  id: string;
  status: string;
  dependencies: string[];
};
export function frontierState(task: FrontierTask, tasks: FrontierTask[]) {
  if (
    task.status === "ready" &&
    task.dependencies.some(
      (id) => tasks.find((parent) => parent.id === id)?.status !== "completed",
    )
  )
    return "waiting";
  return task.status;
}
export function frontierGroup(state: string) {
  if (["blocked", "awaiting_human", "failed"].includes(state))
    return "attention";
  if (["running", "verifying"].includes(state)) return "active";
  if (["completed", "cancelled"].includes(state)) return "finished";
  return "next";
}
export function frontierLabel(state: string) {
  return (
    {
      awaiting_human: "Needs review",
      verifying: "Verifying",
      ready: "Ready",
      running: "Building",
      blocked: "Blocked",
      completed: "Complete",
      waiting: "Waiting on work",
      cancelled: "Skipped",
      failed: "Failed",
    }[state] ?? state
  );
}

// Running is the loop's intent; it does not mean a task can currently dispatch.
export function waitingOnBlocker(
  project: { status?: string; planned?: boolean },
  tasks: FrontierTask[],
  gates: { status: string; scope?: string; taskId?: string }[],
  runs: { status: string; role: string }[],
) {
  if (
    project.status !== "running" ||
    runs.some((run) => run.status === "running" && run.role !== "judge")
  )
    return false;
  const open = gates.filter((gate) => gate.status === "open");
  if (!open.length) return false;
  if (
    open.some(
      (gate) =>
        (gate.scope ?? (gate.taskId ? "task" : "project")) === "project",
    )
  )
    return true;
  if (tasks.some((task) => ["running", "verifying"].includes(task.status)))
    return false;
  return !tasks.some(
    (task) =>
      frontierState(task, tasks) === "ready" &&
      !open.some((gate) => gate.taskId === task.id),
  );
}

export function submittedWait(
  message: { role?: string; kind?: string; runId?: string },
  gate?: { status?: string; judgeRunId?: string; awaitingCapability?: boolean },
) {
  return (
    message.role === "judge" &&
    message.kind === "escalation_response" &&
    !!message.runId &&
    message.runId === gate?.judgeRunId &&
    gate.status === "open" &&
    !!gate.awaitingCapability
  );
}
