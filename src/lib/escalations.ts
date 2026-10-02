import { needsHumanReview } from "./autonomy";

export function recordGateSnapshot<T extends { id: string; status: string }>(
  gates: T[],
  seen: Set<string>,
  initial = false,
): T[] {
  const fresh: T[] = [];
  for (const gate of gates) {
    if (!initial && gate.status === "open" && !seen.has(gate.id))
      fresh.push(gate);
    seen.add(gate.id);
  }
  return fresh;
}

type NoticeGate = {
  id: string;
  status: string;
  type: string;
  projectId: string;
  title?: string;
};
type NoticeProject = {
  id: string;
  name?: string;
  escalationMode?: string;
  bypass?: boolean;
};

/** One notice per affected project, counting every decision still awaiting a human. */
export function groupEscalationNotices(
  gates: NoticeGate[],
  fresh: NoticeGate[],
  projects: NoticeProject[] = [],
) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const current = new Map<string, NoticeGate[]>();
  const currentIds = new Set<string>();
  for (const gate of gates) {
    const project = projectById.get(gate.projectId) ?? {};
    if (!needsHumanReview(gate, project) || currentIds.has(gate.id)) continue;
    currentIds.add(gate.id);
    const items = current.get(gate.projectId) ?? [];
    items.push(gate);
    current.set(gate.projectId, items);
  }
  const affected = new Set(
    fresh.filter((gate) => currentIds.has(gate.id))
      .map((gate) => gate.projectId),
  );
  return [...affected].map((projectId) => {
    const items = current.get(projectId)!;
    const count = items.length;
    return {
      projectId,
      projectName: projectById.get(projectId)?.name ?? "Project",
      count,
      title: count === 1
        ? items[0].title ?? "Your decision is needed"
        : `${count} decisions need you`,
      type: count === 1 ? items[0].type : "Review",
    };
  });
}

export function createChimeGate(intervalMs: number) {
  let last = -Infinity;
  return (now: number) => {
    if (now - last < intervalMs) return false;
    last = now;
    return true;
  };
}
