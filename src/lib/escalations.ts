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
