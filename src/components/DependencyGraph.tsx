import { useId } from "react";
import { ChevronRight } from "lucide-react";
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
  matches,
}: {
  tasks: Task[];
  onSelect: (task: Task) => void;
  matches?: Set<string>;
}) {
  const markerId = useId().replaceAll(":", "");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const layers = new Map<string, number>();
  function layer(task: Task, visiting = new Set<string>()): number {
    if (layers.has(task.id)) return layers.get(task.id)!;
    if (visiting.has(task.id)) return 0;
    visiting.add(task.id);
    const parents = task.dependencies
      .map((id) => byId.get(id))
      .filter((task): task is Task => !!task);
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
  const width = columns.length * 330 + 40,
    height = Math.max(1, ...columns.map((col) => col.length)) * 142 + 80;
  const positions = new Map(
    tasks.map((task) => {
      const col = layers.get(task.id)!;
      const row = columns[col].findIndex((t) => t.id === task.id);
      return [task.id, { x: col * 330 + 24, y: row * 142 + 60 }];
    }),
  );
  return (
    <div
      className="work-path-scroll"
      role="region"
      aria-label="Task dependency map"
      tabIndex={0}
    >
      <div className="work-path-canvas" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <defs>
            <marker
              id={markerId}
              markerWidth="6"
              markerHeight="6"
              refX="5"
              refY="3"
              orient="auto"
            >
              <path d="M0 0L6 3L0 6" fill="var(--lr-signal)" />
            </marker>
          </defs>
          {tasks.flatMap((task) =>
            task.dependencies.map((id) => {
              const from = positions.get(id),
                to = positions.get(task.id);
              if (!from || !to) return null;
              const x = from.x + 258,
                y = from.y + 53;
              return (
                <path
                  key={id + task.id}
                  d={`M${x} ${y} C${x + 44} ${y},${to.x - 44} ${to.y + 53},${to.x} ${to.y + 53}`}
                  fill="none"
                  stroke="var(--lr-signal)"
                  strokeOpacity=".55"
                  strokeWidth="1.25"
                  markerEnd={`url(#${markerId})`}
                />
              );
            }),
          )}
        </svg>
        {columns.map((column, index) => (
          <div
            className="work-path-label"
            key={index}
            style={{ left: index * 330 + 24 }}
          >
            <span>
              {index === 0
                ? "Starting points"
                : `After ${index} ${index === 1 ? "step" : "steps"}`}
            </span>
            <span>{column.length}</span>
          </div>
        ))}
        {tasks.map((task, index) => {
          const position = positions.get(task.id)!,
            state = frontierState(task, tasks);
          return (
            <Button
              key={task.id}
              variant="ghost"
              className={`work-path-node ${state} ${matches && !matches.has(task.id) ? "is-context" : ""}`}
              style={{ left: position.x, top: position.y }}
              aria-label={`Inspect task ${index + 1}: ${task.title}, ${frontierLabel(state)}`}
              onClick={() => onSelect(task)}
            >
              <span className="work-path-node-inner">
                <span className="work-path-node-top">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <span aria-hidden="true">
                    <StatusMark
                      label=""
                      size={16}
                      status={
                        state === "completed"
                          ? "done"
                          : ["running", "verifying"].includes(state)
                            ? "running"
                            : "pending"
                      }
                      color="var(--lr-blue)"
                      doneColor="var(--lr-verified)"
                    />
                  </span>
                </span>
                <strong>{task.title}</strong>
                <span className="work-path-node-state">
                  <span>
                    {matches && !matches.has(task.id)
                      ? "Outside filter"
                      : frontierLabel(state)}
                  </span>
                  <ChevronRight size={14} />
                </span>
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
