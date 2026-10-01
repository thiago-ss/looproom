export type EscalationMode = "human" | "bypass" | "yolo";

export function escalationMode(project: {
  [key: string]: unknown;
  escalationMode?: string;
  bypass?: boolean;
}): EscalationMode {
  if (["human", "bypass", "yolo"].includes(project.escalationMode ?? ""))
    return project.escalationMode as EscalationMode;
  return project.bypass ? "bypass" : "human";
}

export function needsHumanReview(
  gate: { status: string; type: string },
  project: { escalationMode?: string; bypass?: boolean },
) {
  return (
    gate.status === "open" &&
    (gate.type === "pr" || gate.type === "interrupted" || escalationMode(project) !== "yolo")
  );
}

export function taskOpenGate<T extends { status: string; taskId?: string; type: string }>(
  gates: T[],
  taskId?: string,
): T | undefined {
  return gates.find((gate) => gate.status === "open" && gate.taskId === taskId && gate.type === "interrupted")
    ?? gates.find((gate) => gate.status === "open" && gate.taskId === taskId);
}
