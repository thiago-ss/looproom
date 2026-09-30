import { Button } from "./ui/button";
import StatusMark from "./ui/StatusMark";
import { frontierState, frontierLabel } from "../lib/work";

type Task = {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
};
export default function DependencyGraph({
  tasks,
  onSelect,
}: {
  tasks: Task[];
  onSelect: (task: Task) => void;
}) {
  const layers = new Map<string, number>();
  function layer(task: Task, visiting = new Set<string>()): number {
    if (layers.has(task.id)) return layers.get(task.id)!;
    if (visiting.has(task.id)) return 0;
    visiting.add(task.id);
    const parents = task.dependencies
      .map((id) => tasks.find((t) => t.id === id))
      .filter((t): t is Task => !!t);
    const depth = parents.length
      ? Math.max(...parents.map((parent) => layer(parent, new Set(visiting)))) +
        1
      : 0;
    layers.set(task.id, depth);
    return depth;
  }
  tasks.forEach((task) => layer(task));
  const columns = Array.from(
    { length: Math.max(0, ...layers.values()) + 1 },
    (_, depth) => tasks.filter((task) => layers.get(task.id) === depth),
  );
  const positions = new Map(
    tasks.map((task) => {
      const col = layers.get(task.id)!;
      return [
        task.id,
        {
          x: col * 290 + 24,
          y: columns[col].findIndex((t) => t.id === task.id) * 122 + 34,
        },
      ];
    }),
  );
  const width = columns.length * 290 + 30,
    height = Math.max(1, ...columns.map((col) => col.length)) * 122 + 48;
  return (
    <div className="dependency-scroll">
      <div className="dependency-map" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <defs>
            <marker
              id="dependency-arrow"
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
            >
              <path d="M0 0 L7 3.5 L0 7" fill="#9aa9a3" />
            </marker>
          </defs>
          {tasks.flatMap((task) =>
            task.dependencies.map((id) => {
              const from = positions.get(id),
                to = positions.get(task.id);
              if (!from || !to) return null;
              const x = from.x + 242,
                y = from.y + 38;
              return (
                <path
                  key={id + task.id}
                  d={`M ${x} ${y} C ${x + 24} ${y}, ${to.x - 24} ${to.y + 38}, ${to.x} ${to.y + 38}`}
                  fill="none"
                  stroke="#9aa9a3"
                  strokeWidth="1.3"
                  markerEnd="url(#dependency-arrow)"
                />
              );
            }),
          )}
        </svg>
        {tasks.map((task) => {
          const position = positions.get(task.id)!;
          return (
            <Button
              variant="ghost"
              key={task.id}
              className="dependency-node"
              style={{ left: position.x, top: position.y }}
              onClick={() => onSelect(task)}
            >
              <StatusMark
                status={
                  task.status === "completed"
                    ? "done"
                    : ["running", "verifying"].includes(task.status)
                      ? "running"
                      : "pending"
                }
                size={18}
                color="#167a72"
                label=""
              />
              <span>
                <strong>{task.title}</strong>
                <small>
                  {frontierLabel(frontierState(task, tasks))} ·{" "}
                  {task.dependencies.length
                    ? "depends on " +
                      task.dependencies.length +
                      (task.dependencies.length === 1 ? " task" : " tasks")
                    : "no prerequisites"}
                </small>
              </span>
            </Button>
          );
        })}
      </div>
      <p className="field-help">
        Arrows connect prerequisites to dependent work. Select a task to read
        its acceptance and evidence.
      </p>
    </div>
  );
}
