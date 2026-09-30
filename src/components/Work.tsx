import { useState } from "react";
import {
  ArrowUpRight,
  Search,
  GitPullRequest,
  GitBranch,
  Check,
  Layers3,
  List,
  Network,
  ArrowRight,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import StatusMark from "./ui/StatusMark";
import DependencyGraph from "./DependencyGraph";
import { frontierState, frontierGroup, frontierLabel } from "../lib/work";
const groups = [
  {
    id: "active",
    name: "In motion",
    note: "Being built or verified",
    icon: "◉",
  },
  {
    id: "attention",
    name: "Needs attention",
    note: "Waiting for a decision or a fix",
    icon: "□",
  },
  {
    id: "next",
    name: "Up next",
    note: "The remaining work frontier",
    icon: "→",
  },
  {
    id: "finished",
    name: "Finished",
    note: "Completed or explicitly skipped",
    icon: "✓",
  },
];
export default function Work({
  tasks,
  onSelect,
}: {
  tasks: any[];
  onSelect: (task: any) => void;
}) {
  const [view, setView] = useState("frontier"),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all");
  const state = (task: any) => frontierState(task, tasks);
  const counts = Object.fromEntries(
    groups.map((group) => [
      group.id,
      tasks.filter((task) => frontierGroup(state(task)) === group.id).length,
    ]),
  );
  const visible = tasks.filter(
    (task) =>
      (filter === "all" || frontierGroup(state(task)) === filter) &&
      `${task.title} ${task.kind} ${task.id}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <section className="page frontier-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">From intent to evidence</p>
          <h1>Work</h1>
          <p>A small frontier. Every step has a reason.</p>
        </div>
        <Badge variant="outline">{tasks.length} tasks</Badge>
      </div>
      <div className="frontier-ribbon" aria-label="Task summary">
        {groups.map((group) => (
          <Button
            key={group.id}
            variant="ghost"
            className={
              "frontier-stage " + (filter === group.id ? "selected" : "")
            }
            aria-pressed={filter === group.id}
            onClick={() => {
              setView("frontier");
              setFilter(filter === group.id ? "all" : group.id);
            }}
          >
            <span className={"frontier-symbol " + group.id}>{group.icon}</span>
            <span>
              <strong>{group.name}</strong>
              <small>
                {counts[group.id]} {counts[group.id] === 1 ? "task" : "tasks"}
              </small>
            </span>
          </Button>
        ))}
      </div>
      <div className="frontier-toolbar">
        <Tabs value={view} onValueChange={setView}>
          <TabsList>
            <TabsTrigger value="frontier">
              <List size={14} />
              Frontier
            </TabsTrigger>
            <TabsTrigger value="graph">
              <Network size={14} />
              Dependencies
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {view === "frontier" ? (
          <div className="frontier-tools">
            <div className="frontier-search">
              <Search size={14} />
              <Input
                aria-label="Search tasks"
                placeholder="Find a task…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger aria-label="Filter work">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All work</SelectItem>
                {groups.map((group) => (
                  <SelectItem value={group.id} key={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
      {!tasks.length ? (
        <div className="frontier-empty">
          <Layers3 size={28} />
          <h2>The first useful step starts with your goal.</h2>
          <p>
            Start the loop in Goal. The orchestrator will turn the outcome into
            a bounded plan.
          </p>
        </div>
      ) : view === "graph" ? (
        <>
          <div className="graph-caption">
            <GitBranch size={14} /> The complete dependency map · {tasks.length}{" "}
            tasks
          </div>
          <DependencyGraph tasks={tasks} onSelect={onSelect} />
        </>
      ) : !visible.length ? (
        <div className="frontier-empty">
          <Search size={26} />
          <h2>No matching work.</h2>
          <Button
            variant="outline"
            onClick={() => {
              setFilter("all");
              setQuery("");
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="frontier-sections">
          {groups.map((group) => {
            const items = visible.filter(
              (task) => frontierGroup(state(task)) === group.id,
            );
            if (!items.length) return null;
            return (
              <section
                className={"frontier-section " + group.id}
                key={group.id}
              >
                <div className="frontier-section-heading">
                  <h2>
                    {group.name}
                    <span>{items.length}</span>
                  </h2>
                  <p>{group.note}</p>
                </div>
                <div className="frontier-tasks">
                  {items.map((task) => {
                    const current = state(task),
                      parents = task.dependencies.map((id: string) =>
                        tasks.find((parent) => parent.id === id),
                      );
                    return (
                      <Button
                        variant="ghost"
                        className="frontier-task"
                        key={task.id}
                        onClick={() => onSelect(task)}
                      >
                        <span className="frontier-task-number">
                          {String(tasks.indexOf(task) + 1).padStart(2, "0")}
                        </span>
                        <div className="frontier-task-main">
                          <div className="frontier-task-title">
                            <StatusMark
                              label=""
                              size={18}
                              color="#167a72"
                              doneColor="#25724b"
                              status={
                                current === "completed"
                                  ? "done"
                                  : ["running", "verifying"].includes(current)
                                    ? "running"
                                    : current === "failed"
                                      ? "failed"
                                      : "pending"
                              }
                            />
                            <strong>{task.title}</strong>
                          </div>
                          <div className="frontier-task-meta">
                            <span>{task.kind}</span>
                            <span>·</span>
                            <span className="mono">{task.id.slice(0, 8)}</span>
                            {task.pr ? (
                              <span>
                                <GitPullRequest size={12} />
                                PR ready
                              </span>
                            ) : task.checks?.length ? (
                              <span>
                                <Check size={12} />
                                {
                                  task.checks.filter(
                                    (check: any) => check.code === 0,
                                  ).length
                                }
                                /{task.checks.length} checks passed
                              </span>
                            ) : null}
                          </div>
                          {parents.length ? (
                            <p className="frontier-prerequisites">
                              <GitBranch size={12} />
                              {current === "waiting"
                                ? "Waiting on: "
                                : "Prerequisites: "}
                              {parents
                                .map(
                                  (parent: any) =>
                                    parent?.title ?? "Unavailable task",
                                )
                                .join(" · ")}
                            </p>
                          ) : null}
                        </div>
                        <Badge
                          variant="outline"
                          className={"frontier-state " + current}
                        >
                          {frontierLabel(current)}
                        </Badge>
                        <ArrowUpRight className="task-open" size={16} />
                      </Button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <div className="frontier-footnote">
        <GitBranch size={14} />
        <span>Implementation stays in isolated worktrees.</span>
        <ArrowRight size={13} />
        <span>Every merge comes back to you.</span>
      </div>
    </section>
  );
}
