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
