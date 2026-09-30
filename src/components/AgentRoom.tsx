import { lazy, Suspense, useState } from "react";
import {
  ArrowUpRight,
  GitBranch,
  Radio,
  Check,
  Circle,
  ChevronRight,
  ArrowRight,
  Terminal,
  History,
} from "lucide-react";
import { Button } from "./ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { Badge } from "./ui/badge";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
const Orb = lazy(() => import("./AgentOrb"));
const roles = [
  {
    id: "orchestrator",
    name: "Orchestrator",
    job: "Sets the destination",
    short: "Plan",
    number: "01",
  },
  {
    id: "research",
    name: "Researcher",
    job: "Finds the evidence",
    short: "Research",
    number: "02",
  },
  {
    id: "implementation",
    name: "Builder",
    job: "Makes it real",
    short: "Build",
    number: "03",
  },
  {
    id: "review",
    name: "Reviewer",
    job: "Challenges the result",
    short: "Verify",
    number: "04",
  },
];
export default function AgentRoom({
  runs,
  tasks,
  settings,
  events,
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
    selected === "orchestrator" ? settings.orchestrator : settings.subagent;
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
      <div className="page-heading">
        <div>
          <p className="eyebrow">The collective</p>
          <h1>Agent room</h1>
          <p>Follow the work. Get closer when something catches your eye.</p>
        </div>
        <Badge variant="outline" className="room-live">
          <Radio size={13} />
          {activeCount ? `${activeCount} active` : "Standing by"}
        </Badge>
      </div>
      <div className="room-layout">
        <div className="room-stage">
          <div className="stage-caption">
            <span className="mono">Shared workflow</span>
            <span>Select an agent to inspect</span>
          </div>
          <div className="agent-constellation" aria-label="Agent workflow">
            <svg
              className="room-wires"
              viewBox="0 0 600 440"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path d="M150 110 H450 V330 H150 V110" />
              <path d="M150 110 L450 330" className="secondary-wire" />
            </svg>
            {roles.map((item) => {
              const running = runs.some(
                (run: any) => run.role === item.id && run.status === "running",
              );
              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      className={`agent-station station-${item.id} ${selected === item.id ? "is-selected" : ""} ${running ? "is-active" : ""}`}
                      onClick={() => setSelected(item.id)}
                      aria-pressed={selected === item.id}
                      aria-label={`Inspect ${item.name}, ${running ? "thinking" : "idle"}`}
                    >
                      <span className="station-number mono">
                        {item.number} / {item.short}
                      </span>
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
                  </TooltipTrigger>
                  <TooltipContent>
                    {item.job} · select to inspect
                  </TooltipContent>
                </Tooltip>
              );
            })}
            <div className="room-center">
              <img src="/brand/looproom-mark.svg" alt="" />
              <span className="mono">One shared goal</span>
            </div>
          </div>
          <div className="stage-footer">
            <GitBranch size={14} />
            <span>Plans → evidence → worktrees → independent review</span>
            <span className="mono">Human approves promotion</span>
          </div>
        </div>
        <aside className="agent-inspector" aria-label={`${role.name} details`}>
          <div className="inspector-heading">
            <span className="eyebrow">Agent {role.number}</span>
            <ArrowUpRight size={17} />
          </div>
          <h2>{role.name}</h2>
          <p>{role.job}</p>
          <div className="agent-profile">
            <span className="mono">{profile.model}</span>
            <Badge variant="outline">{profile.effort}</Badge>
          </div>
          <div className="inspector-section">
            <span className="eyebrow">Current assignment</span>
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
              <p>
                {active
                  ? "Reading the project and planning the next useful step."
                  : "Ready when the coordinator assigns work."}
              </p>
            )}
          </div>
          <div className="inspector-section">
            <span className="eyebrow">Runtime</span>
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
          {latest?.error ? <p className="field-error">{latest.error}</p> : null}
          <p className="inspector-note">
            Connections show the workflow contract. Activity below records what
            actually happened.
          </p>
        </aside>
      </div>
      <div className="section-heading">
        <div>
          <h2>Activity & handoffs</h2>
          <p className="muted">A shared record of the work</p>
        </div>
        <Tabs value={feed} onValueChange={setFeed}>
          <TabsList>
            <TabsTrigger value="all">Everyone</TabsTrigger>
            <TabsTrigger value="agent">{role.name}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="room-feed">
        {visibleEvents.length ? (
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
