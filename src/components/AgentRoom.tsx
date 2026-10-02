import { Alert } from "./arc/alert/alert";
import { lazy, Suspense, useState } from "react";
import {
  Radio,
  Check,
  Circle,
  ChevronRight,
  ArrowRight,
  Terminal,
  History,
  CircleHelp,
} from "lucide-react";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { Badge } from "./ui/badge";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { DotmSquare3 } from "./ui/dotm-square-3";
const Orb = lazy(() => import("./AgentOrb"));
const roles = [
  {
    id: "orchestrator",
    name: "Orchestrator",
    job: "Sets the destination",
  },
  {
    id: "research",
    name: "Researcher",
    job: "Finds the evidence",
  },
  {
    id: "implementation",
    name: "Builder",
    job: "Makes it real",
  },
  { id: "judge", name: "Judge", job: "Answers escalations; merges stay human" },
  {
    id: "review",
    name: "Reviewer",
    job: "Challenges the result",
  },
];
export default function AgentRoom({
  runs,
  tasks,
  settings,
  events,
  historyStatus,
  historyError,
  retryHistory,
  onSelectTask,
}: any) {
  const [selected, setSelected] = useState("orchestrator"),
    [feed, setFeed] = useState("all");
  const role = roles.find((role) => role.id === selected)!;
  const roleRuns = runs.filter((run: any) => run.role === selected);
  const active = roleRuns.find((run: any) => run.status === "running");
  const latest = active ?? roleRuns.at(-1);
  const task = tasks.find((task: any) => task.id === latest?.taskId);
  const profile =
    selected === "orchestrator"
      ? settings.orchestrator
      : selected === "judge"
        ? (settings.judge ?? settings.subagent)
        : settings.subagent;
  const activeCount = runs.filter(
    (run: any) => run.status === "running",
  ).length;
  const visibleEvents = events.filter(
    (event: any) =>
      feed === "all" ||
      event.data.role === selected ||
      roleRuns.some(
        (run: any) => run.id === event.data.runId || run.id === event.data.run,
      ),
  );
  return (
    <section className="page room-page">
      <h1 className="sr-only">Agent room</h1>
      <div className="workspace-caption">
        <Badge variant="outline" className="room-live">
          <Radio size={13} />
          {activeCount ? `${activeCount} active` : "Standing by"}
        </Badge>
      </div>
      <div className="room-layout">
        <div className="room-stage">
          <div className="agent-constellation" aria-label="Agent workflow">
            <svg
              className="room-wires"
              viewBox="0 0 600 440"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path d="M150 110 C150 30 450 30 450 110 C550 110 550 330 450 330 C450 410 150 410 150 330 C50 330 50 110 150 110" />
              <path
                d="M150 110 C300 110 300 330 450 330"
                className="secondary-wire"
              />
            </svg>
            {roles
              .filter((item) => item.id !== "judge")
              .map((item) => {
                const running = runs.some(
                  (run: any) =>
                    run.role === item.id && run.status === "running",
                );
                return (
                  <Tooltip
                    key={item.id}
                    content={<>{item.job} · select to inspect</>}
                  >
                    <Button
                      variant="ghost"
                      className={`agent-station station-${item.id} ${selected === item.id ? "is-selected" : ""} ${running ? "is-active" : ""}`}
                      onClick={() => setSelected(item.id)}
                      aria-pressed={selected === item.id}
                      aria-label={`Inspect ${item.name}, ${running ? "thinking" : "idle"}`}
                    >
                      <span className="station-orb">
                        <Suspense
                          fallback={<span className="orb-placeholder" />}
                        >
                          <Orb active={running} size={110} identity={item.id} />
                        </Suspense>
                      </span>
                      <strong>{item.name}</strong>
                      <span className="station-status">
                        <i />
                        {running ? "Thinking" : "Idle"}
                      </span>
                    </Button>
                  </Tooltip>
                );
              })}
            <Tooltip
              content={<>Answers escalations; you approve every merge.</>}
            >
              <Button
                variant="ghost"
                className={`agent-station station-judge ${selected === "judge" ? "is-selected" : ""}`}
                aria-label="Inspect Judge"
                aria-pressed={selected === "judge"}
                onClick={() => setSelected("judge")}
              >
                <Suspense fallback={<span className="orb-placeholder" />}>
                  <Orb
                    active={runs.some(
                      (run: any) =>
                        run.role === "judge" && run.status === "running",
                    )}
                    size={56}
                    identity="judge"
                  />
                </Suspense>
                <strong>Judge</strong>
              </Button>
            </Tooltip>
          </div>
        </div>
        <aside className="agent-inspector" aria-label={`${role.name} details`}>
          <div className="inspector-heading">
            <Badge variant="outline">{active ? "Thinking" : "Idle"}</Badge>
            <Tooltip
              content={
                <>
                  Connections show planned handoffs. Activity records actual
                  events.
                </>
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="About workflow connections"
              >
                <CircleHelp size={15} />
              </Button>
            </Tooltip>
          </div>
          <h2>{role.name}</h2>
          <div className="agent-profile">
            <span className="mono">{profile.model}</span>
            <Badge variant="outline">{profile.effort}</Badge>
          </div>
          <div className="inspector-section">
            <span className="eyebrow">Assignment</span>
            {task ? (
              <Button
                variant="ghost"
                className="assignment-link"
                onClick={() => onSelectTask(task)}
              >
                <span>{task.title}</span>
                <ChevronRight size={16} />
              </Button>
            ) : (
              <p>{active ? "Planning" : "No assignment"}</p>
            )}
          </div>
          <div className="inspector-section">
            <dl>
              <div>
                <dt>State</dt>
                <dd>{active ? "Thinking" : "Idle"}</dd>
              </div>
              <div>
                <dt>Completed turns</dt>
                <dd>
                  {
                    roleRuns.filter((run: any) => run.status === "completed")
                      .length
                  }
                </dd>
              </div>
              {latest ? (
                <div>
                  <dt>Last turn</dt>
                  <dd>{latest.status.replaceAll("_", " ")}</dd>
                </div>
              ) : null}
            </dl>
          </div>
          {latest?.activity ? (
            <div className="agent-terminal">
              <Terminal size={14} />
              <span className="sr-only">Last recorded activity</span>
              <p>
                {typeof latest.activity === "string"
                  ? latest.activity
                  : JSON.stringify(latest.activity)}
              </p>
            </div>
          ) : null}
          {latest?.error ? <Alert tone="danger" title={latest.error} /> : null}
        </aside>
      </div>
      <div className="section-heading">
        <div>
          <h2>Activity</h2>
        </div>
        <Tabs value={feed} onValueChange={setFeed}>
          <TabsList>
            <TabsTrigger value="all">Everyone</TabsTrigger>
            <TabsTrigger value="agent">{role.name}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="room-feed">
        {historyStatus === "loading" ? (
          <div className="room-feed-empty" role="status">
            <DotmSquare3 size={20} dotSize={3} color="var(--lr-signal)" />
            <p>Loading recorded activity…</p>
          </div>
        ) : historyStatus === "error" ? (
          <Alert tone="danger" title="Could not load recorded activity">
            <span>{historyError} </span>
            <Button variant="ghost" onClick={retryHistory}>Retry</Button>
          </Alert>
        ) : visibleEvents.length ? (
          visibleEvents.slice(0, 18).map((event: any) => (
            <div className="room-event" key={event.seq}>
              <span
                className={`event-symbol ${event.type.includes("gate") ? "needs-attention" : ""}`}
              >
                {event.type.includes("completed") ? (
                  <Check size={14} />
                ) : event.type.includes("handoff") ? (
                  <ArrowRight size={14} />
                ) : (
                  <Circle size={10} />
                )}
              </span>
              <div>
                <strong>{event.type.replaceAll("-", " ")}</strong>
                <p>
                  {event.data.title ??
                    event.data.command ??
                    event.data.summary ??
                    event.data.role ??
                    "Project state recorded"}
                </p>
              </div>
              <time dateTime={event.created_at}>
                {new Date(event.created_at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
          ))
        ) : (
          <div className="room-feed-empty">
            <History size={20} />
            <p>
              No recorded activity {feed === "agent" ? "for this agent" : "yet"}
              .
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
