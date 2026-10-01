import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  GitBranch,
  GitPullRequest,
  Layers3,
  List,
  LockKeyhole,
  Network,
  Search,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { SearchField } from "./arc/search-field/search-field";
import { EmptyState } from "./arc/empty-state/empty-state";
import { Progress } from "./arc/progress/progress";
import { Timeline } from "./arc/timeline/timeline";
import SegmentedControl from "./arc/segmented-control/segmented-control";
import { Accordion } from "./arc/accordion/accordion";
import { DotmSquare3 } from "./ui/dotm-square-3";
import StatusMark from "./ui/StatusMark";
import JudgePending from "./JudgePending";
import DependencyGraph from "./DependencyGraph";
import { frontierState, frontierGroup, frontierLabel } from "../lib/work";
import { escalationMode } from "../lib/autonomy";
import "./work.css";

const AgentOrb = lazy(() => import("./AgentOrb"));
const groups = [
  { id: "active", name: "In motion", color: "blue" },
  { id: "attention", name: "At a gate", color: "peach" },
  { id: "next", name: "Queued", color: "plum" },
  { id: "finished", name: "Finished", color: "green" },
];
const roleName = (role: string) =>
  ({
    implementation: "Builder",
    research: "Researcher",
    review: "Reviewer",
    judge: "Judge",
    orchestrator: "Orchestrator",
  })[role] ?? "Agent";
const glyph = (state: string) =>
  state === "completed"
    ? "done"
    : ["running", "verifying"].includes(state)
      ? "running"
      : state === "failed"
        ? "failed"
        : "pending";
function outputSummary(run: any) {
  try {
    return JSON.parse(run.output).summary ?? run.output;
  } catch {
    return run.error ?? run.output ?? "";
  }
}

export default function Work({
  tasks,
  runs = [],
  gates = [],
  messages = [],
  project,
  onSelect,
  onReview,
  onGoal,
}: {
  tasks: any[];
  runs?: any[];
  gates?: any[];
  messages?: any[];
  project: any;
  onSelect: (task: any) => void;
  onReview: () => void;
  onGoal: () => void;
}) {
  const [view, setView] = useState("stream"),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [selectedId, setSelectedId] = useState(""),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const records = useMemo(
    () =>
      tasks.map((task, index) => ({
        task,
        index,
        state: frontierState(task, tasks),
        group: frontierGroup(frontierState(task, tasks)),
      })),
    [tasks],
  );
  const byId = new Map(records.map((record) => [record.task.id, record]));
  const counts = Object.fromEntries(
    groups.map((group) => [
      group.id,
      records.filter((record) => record.group === group.id).length,
    ]),
  );
  const visible = records.filter(
    ({ task, group }) =>
      (filter === "all" || group === filter) &&
      `${task.title} ${task.kind} ${task.description ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const selected =
    visible.find((record) => record.task.id === selectedId) ??
    visible.find((record) => record.group === "active") ??
    visible.find((record) => record.group === "attention") ??
    visible[0];
  const task = selected?.task;
  const gate = gates.find(
    (gate) => gate.status === "open" && gate.taskId === task?.id,
  );
  const taskRuns = runs.filter((run) => run.taskId === task?.id);
  const active = taskRuns.find((run) => run.status === "running");
  const role =
    active?.role ??
    (gate?.judgeStatus
      ? "judge"
      : task?.kind === "research"
        ? "research"
        : "implementation");
  const parents = (task?.dependencies ?? [])
    .map((id: string) => byId.get(id))
    .filter(Boolean);
  const children = records.filter((record) =>
    record.task.dependencies.includes(task?.id),
  );
  const complete = tasks.filter((task) => task.status === "completed").length;
  const mode = escalationMode(project);
  const checks = task?.checks ?? [];
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  function select(id: string) {
    setSelectedId(id);
    if (!visible.some((record) => record.task.id === id)) {
      setFilter("all");
      setQuery("");
    }
  }
  const responses = new Map(
    messages
      .filter((message) => message.runId)
      .map((message) => [message.runId, message.text]),
  );
  const events = taskRuns.slice(-12).map((run) => ({
    id: run.id,
    at: run.finishedAt ?? run.createdAt,
    actor: roleName(run.role),
    title:
      run.status === "running"
        ? "Working in the task worktree"
        : run.status === "completed"
          ? "Finished a turn"
          : run.status === "interrupted"
            ? "Turn interrupted"
            : "Turn failed",
    meta: `${run.model} · ${run.effort}`,
    tone:
      run.status === "failed"
        ? ("danger" as const)
        : run.status === "completed"
          ? ("success" as const)
          : ("neutral" as const),
    icon: <Terminal size={14} />,
    detail:
      (responses.get(run.id) ?? outputSummary(run)) ? (
        <pre className="work-run-output">
          {String(responses.get(run.id) ?? outputSummary(run)).slice(-16000)}
        </pre>
      ) : undefined,
  }));
  return (
    <section className="page workbench">
      <h1 className="sr-only">Work</h1>
      <div className="work-overview">
        <div className="work-completion">
          <span>
            <strong>{complete}</strong>
            <span> / {tasks.length} complete</span>
          </span>
          <Progress
            className="work-progress"
            value={complete}
            max={Math.max(1, tasks.length)}
            label="Completed tasks"
          />
        </div>
        <SegmentedControl
          className="work-filters"
          label="Filter tasks by state"
          value={filter}
          onValueChange={setFilter}
          options={[
            {
              value: "all",
              label: "All",
              accessory: <span className="work-count">{tasks.length}</span>,
            },
            ...groups.map((group) => ({
              value: group.id,
              label: group.name,
              accessory: (
                <span className={`work-count ${group.color}`}>
                  {counts[group.id]}
                </span>
              ),
            })),
          ]}
        />
      </div>
      <Tabs value={view} onValueChange={setView} className="work-layout-tabs">
        <div className="work-controls">
          <TabsList>
            <TabsTrigger value="stream">
              <List size={15} /> Workstream
            </TabsTrigger>
            <TabsTrigger value="connections">
              <Network size={15} /> Connections
            </TabsTrigger>
          </TabsList>
          <div className="work-search">
            <SearchField
              label="Search tasks"
              placeholder="Find a task…"
              value={query}
              onValueChange={setQuery}
            />
          </div>
        </div>
        <TabsContent value="stream" className="work-stream-panel">
          {!tasks.length ? (
            <EmptyState
              title="Room for the next useful thing."
              description="Give your agents a goal to build their first plan."
              icon={<Layers3 size={28} />}
              action={
                <Button onClick={onGoal}>
                  Open Goal <ArrowRight size={15} />
                </Button>
              }
            />
          ) : !visible.length ? (
            <EmptyState
              title="Nothing in this view"
              description="Try another state or clear your search."
              icon={<Search size={26} />}
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFilter("all");
                    setQuery("");
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <div className="work-split">
              <div className="work-queue" aria-label="Tasks">
                {groups.map((group) => {
                  const items = visible.filter(
                    (record) => record.group === group.id,
                  );
                  return items.length ? (
                    <section
                      className={`work-group ${group.color}`}
                      key={group.id}
                    >
                      <div className="work-group-label">
                        <span className="work-state-dot" />
                        <h2>{group.name}</h2>
                        <span>{items.length}</span>
                      </div>
                      <div className="work-records">
                        {items.map(({ task, index, state }) => (
                          <Button
                            variant="ghost"
                            key={task.id}
                            className={`work-record ${selected?.task.id === task.id ? "is-selected" : ""}`}
                            aria-pressed={selected?.task.id === task.id}
                            aria-label={`Inspect task ${index + 1}: ${task.title}, ${frontierLabel(state)}`}
                            onClick={() => setSelectedId(task.id)}
                          >
                            <span className="work-record-grid">
                              <span
                                className="work-record-mark"
                                aria-hidden="true"
                              >
                                <StatusMark
                                  label=""
                                  size={18}
                                  status={glyph(state)}
                                  color="var(--lr-blue)"
                                  doneColor="var(--lr-verified)"
                                />
                              </span>
                              <span className="work-record-content">
                                <strong>{task.title}</strong>
                                <span className="work-record-meta">
                                  <span>
                                    {String(index + 1).padStart(2, "0")}
                                  </span>
                                  <span className={`work-status ${state}`}>
                                    {frontierLabel(state)}
                                  </span>
                                  {task.pr ? (
                                    <GitPullRequest size={12} />
                                  ) : task.dependencies.length ? (
                                    <span className="work-dependency-count">
                                      <GitBranch size={12} />
                                      {task.dependencies.length}
                                    </span>
                                  ) : null}
                                </span>
                              </span>
                              <ChevronRight
                                size={15}
                                className="work-record-arrow"
                              />
                            </span>
                          </Button>
                        ))}
                      </div>
                    </section>
                  ) : null;
                })}
              </div>
              <aside className="work-inspector" aria-label="Selected task">
                <div className="work-inspector-top">
                  <span>
                    Task {String(selected!.index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Previous task"
                      disabled={visible.indexOf(selected!) === 0}
                      onClick={() =>
                        setSelectedId(
                          visible[visible.indexOf(selected!) - 1].task.id,
                        )
                      }
                    >
                      <ArrowLeft size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Next task"
                      disabled={
                        visible.indexOf(selected!) === visible.length - 1
                      }
                      onClick={() =>
                        setSelectedId(
                          visible[visible.indexOf(selected!) + 1].task.id,
                        )
                      }
                    >
                      <ArrowRight size={15} />
                    </Button>
                  </div>
                </div>
                <div className="work-task-heading">
                  <Badge
                    variant="secondary"
                    className={`work-status ${selected!.state}`}
                  >
                    {frontierLabel(selected!.state)}
                  </Badge>
                  <h2>{task.title}</h2>
                  <div className="work-agent">
                    <Suspense
                      fallback={<span className="work-orb-placeholder" />}
                    >
                      <AgentOrb identity={role} active={!!active} size={38} />
                    </Suspense>
                    <div>
                      <strong>{roleName(role)}</strong>
                      <span>
                        {active
                          ? active.activity === "commandExecution"
                            ? "Running a command"
                            : active.activity === "fileChange"
                              ? "Editing the worktree"
                              : "Thinking"
                          : selected!.state === "completed"
                            ? "Task complete"
                            : selected!.state === "waiting"
                              ? "Waiting for a prerequisite"
                              : gate?.awaitingCapability
                                ? "Waiting for the next check"
                                : "No active turn"}
                      </span>
                    </div>
                    {active ? (
                      <DotmSquare3
                        size={18}
                        dotSize={3}
                        color="var(--lr-blue)"
                      />
                    ) : null}
                  </div>
                </div>
                <Tabs
                  key={task.id}
                  defaultValue="overview"
                  className="work-detail-tabs"
                >
                  <TabsList variant="line">
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                    <TabsTrigger value="activity">
                      Activity{" "}
                      <span className="work-tab-count">{taskRuns.length}</span>
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="work-detail-panel">
                    {gate ? (
                      <div className="work-blocker">
                        <div className="work-blocker-heading">
                          <LockKeyhole size={15} />
                          <strong>
                            {gate.type === "pr"
                              ? "Ready for your review"
                              : gate.awaitingCapability
                                ? "Judge replied · still blocked"
                                : "A decision is holding this task"}
                          </strong>
                        </div>
                        {["pending", "running"].includes(gate.judgeStatus) ? (
                          <p role="status">
                            <JudgePending
                              text={
                                gate.judgeRecoveryStatus === "verifying"
                                  ? "Running isolated checks…"
                                  : gate.judgeRecoveryStatus === "running"
                                  ? "Resolving this escalation…"
                                  : "Reviewing this escalation…"
                              }
                            />
                          </p>
                        ) : (
                          <p className="work-blocker-copy">{gate.detail}</p>
                        )}
                        <div className="work-blocker-foot">
                          <span>
                            {gate.type === "pr"
                              ? "You approve the merge"
                              : mode === "yolo"
                                ? gate.judgeNextAttemptAt
                                  ? `Next check ${new Date(gate.judgeNextAttemptAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                                  : "Handled by the judge"
                                : "Waiting for a response"}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={
                              gate.type === "pr" || mode !== "yolo"
                                ? onReview
                                : onGoal
                            }
                          >
                            {gate.type === "pr" || mode !== "yolo"
                              ? "Review"
                              : "Conversation"}
                            <ArrowUpRight size={14} />
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    <p className="work-description">
                      {task.description ||
                        "The agent has not added a task description."}
                    </p>
                    {parents.length || children.length ? (
                      <section className="work-links">
                        <h3>
                          <GitBranch size={14} /> Connected work
                        </h3>
                        <div className="work-linked-items">
                          {parents.map((parent: any) => (
                            <Button
                              variant="ghost"
                              key={parent.task.id}
                              className="work-linked-task"
                              onClick={() => select(parent.task.id)}
                            >
                              <span className="work-linked-grid">
                                <span className="work-link-number">
                                  {String(parent.index + 1).padStart(2, "0")}
                                </span>
                                <span>
                                  <small>
                                    {parent.state === "completed"
                                      ? "Prerequisite complete"
                                      : "Waiting on"}
                                  </small>
                                  <strong>{parent.task.title}</strong>
                                </span>
                                <ArrowUpRight size={13} />
                              </span>
                            </Button>
                          ))}
                          {children.length ? (
                            <div className="work-unlocks">
                              <ArrowDownRight size={14} />
                              <span>
                                Unblocks {children.length}{" "}
                                {children.length === 1 ? "task" : "tasks"}
                              </span>
                              <div>
                                {children.map((child) => (
                                  <Button
                                    key={child.task.id}
                                    variant="ghost"
                                    size="sm"
                                    aria-label={`Inspect dependent task ${child.index + 1}: ${child.task.title}`}
                                    onClick={() => select(child.task.id)}
                                  >
                                    {String(child.index + 1).padStart(2, "0")}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </section>
                    ) : null}
                    <section className="work-acceptance">
                      <h3>
                        <ShieldCheck size={14} /> Definition of done
                      </h3>
                      <ul>
                        {(task.acceptance ?? []).map(
                          (line: string, i: number) => (
                            <li key={i}>
                              <span aria-hidden="true">
                                {task.status === "completed" ? (
                                  <Check size={13} />
                                ) : (
                                  <span className="work-criterion-dot" />
                                )}
                              </span>
                              <span>{line}</span>
                            </li>
                          ),
                        )}
                      </ul>
                      {!task.acceptance?.length ? (
                        <p className="muted">
                          No acceptance criteria recorded.
                        </p>
                      ) : null}
                    </section>
                    {checks.length ? (
                      <section className="work-checks">
                        <h3>
                          <Terminal size={14} /> Checks{" "}
                          <span>
                            {
                              checks.filter((check: any) => check.code === 0)
                                .length
                            }
                            /{checks.length} passed
                          </span>
                        </h3>
                        <Accordion
                          defaultOpen={-1}
                          items={checks.map((check: any) => ({
                            title: `${check.code === 0 ? "Passed" : "Failed"} · ${check.command}`,
                            content: (
                              <pre className="work-run-output">
                                {check.output}
                              </pre>
                            ),
                          }))}
                        />
                      </section>
                    ) : null}
                  </TabsContent>
                  <TabsContent value="activity" className="work-detail-panel">
                    {events.length ? (
                      <Timeline
                        label="Task agent activity"
                        events={events}
                        now={now}
                        timeZone={timeZone}
                        headingLevel={3}
                        scrollToNew={false}
                        className="work-timeline"
                      />
                    ) : (
                      <EmptyState
                        title="No turns yet"
                        description="The first agent turn will appear here."
                        icon={<Terminal size={24} />}
                      />
                    )}
                  </TabsContent>
                </Tabs>
                <div className="work-inspector-footer">
                  <span>
                    {task.pr ? (
                      <>
                        <GitPullRequest size={14} /> Pull request available
                      </>
                    ) : task.worktree ? (
                      <>
                        <GitBranch size={14} /> Isolated worktree
                      </>
                    ) : (
                      <>
                        <Layers3 size={14} />{" "}
                        {task.kind === "research"
                          ? "Research"
                          : "Implementation"}
                      </>
                    )}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onSelect(task)}
                  >
                    Open task <ArrowUpRight size={14} />
                  </Button>
                </div>
              </aside>
            </div>
          )}
        </TabsContent>
        <TabsContent value="connections" className="work-connections-panel">
          {tasks.length ? (
            <>
              <div className="work-map-caption">
                <Network size={15} />
                <span>Follow the path from prerequisite to next task.</span>
                <span>{tasks.length} nodes</span>
              </div>
              <DependencyGraph
                tasks={tasks}
                matches={new Set(visible.map((record) => record.task.id))}
                onSelect={(task) => {
                  select(task.id);
                  setView("stream");
                }}
              />
            </>
          ) : (
            <EmptyState
              title="A plan creates the first connection"
              description="Give your agents a goal to start planning."
              icon={<Network size={28} />}
              action={<Button onClick={onGoal}>Open Goal</Button>}
            />
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
