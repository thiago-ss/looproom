import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Layers3,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Users2,
  X,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { DotmSquare3 } from "./components/ui/dotm-square-3";
import Stepper, { Step } from "./components/ui/Stepper";
import StatusMark from "./components/ui/StatusMark";
import DependencyGraph from "./components/DependencyGraph";
import { api, type Data } from "./lib/api";

const AgentOrb = lazy(() => import("./components/AgentOrb"));
type View = "goal" | "work" | "room" | "review" | "memory" | "settings";
const NAV = [
  { id: "goal", label: "Goal", icon: MessageSquare },
  { id: "work", label: "Work", icon: Layers3 },
  { id: "room", label: "Agent room", icon: Users2 },
  { id: "review", label: "Review", icon: GitPullRequest },
  { id: "memory", label: "Memory", icon: Search },
] as const;
function Pending({ label }: { label: string }) {
  return (
    <span className="pending" role="status">
      <DotmSquare3 size={18} dotSize={3} color="#167a72" />
      <span>{label}</span>
    </span>
  );
}
function Orb({
  active = false,
  size = 54,
  identity,
}: {
  active?: boolean;
  size?: number;
  identity?: string;
}) {
  return (
    <Suspense
      fallback={
        <span
          className="orb-placeholder"
          style={{ width: size, height: size }}
        />
      }
    >
      <AgentOrb active={active} size={size} identity={identity} />
    </Suspense>
  );
}
function DateLabel({ date }: { date: string }) {
  return (
    <time dateTime={date}>
      {new Date(date).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}
function Empty({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{text}</p>
      {children}
    </div>
  );
}
const statusText = (status: string) =>
  ({
    awaiting_human: "Needs review",
    verifying: "Verifying",
    ready: "Ready",
    running: "Running",
    blocked: "Blocked",
    completed: "Complete",
    paused: "Paused",
    stopped: "Stopped",
    idle: "Waiting for a goal",
  })[status] ?? status;
const glyph = (
  status: string,
): "pending" | "running" | "done" | "failed" | "cancelled" =>
  status === "completed"
    ? "done"
    : ["running", "verifying"].includes(status)
      ? "running"
      : status === "failed"
        ? "failed"
        : status === "cancelled"
          ? "cancelled"
          : "pending";

export default function App() {
  const [data, setData] = useState<Data | null>(null),
    [connectionError, setConnectionError] = useState("");
  const [selectedId, setSelectedId] = useState(
    () => localStorage.getItem("looproom.project") ?? "",
  );
  const [view, setView] = useState<View>("goal"),
    [onboarding, setOnboarding] = useState(false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [inspect, setInspect] = useState<any>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  refreshRef.current = async () => {
    try {
      setData(await api("/state"));
      setConnectionError("");
    } catch (error) {
      setConnectionError((error as Error).message);
    }
  };
  useEffect(() => {
    let alive = true;
    void api<Data>("/state")
      .then((state) => {
        if (alive) {
          setData(state);
          if (!state.projects.length) setOnboarding(true);
        }
      })
      .catch((error) => setConnectionError(error.message));
    const events = new EventSource("/api/events");
    events.onmessage = () => {
      if (alive) void refreshRef.current();
    };
    const timer = setInterval(() => {
      if (alive) void refreshRef.current();
    }, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
      events.close();
    };
  }, []);
  const project =
    data?.projects.find((project) => project.id === selectedId) ??
    data?.projects[0];
  useEffect(() => {
    if (project) {
      localStorage.setItem("looproom.project", project.id);
      setSelectedId(project.id);
    }
  }, [project?.id]);
  async function act(fn: () => Promise<any>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await refreshRef.current();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <main className="boot">
        <img src="/brand/looproom-mark.svg" alt="Looproom" />
        <Pending label="Opening your workspace" />
        {connectionError ? (
          <div role="alert">
            <p>{connectionError}</p>
            <p>Start the local coordinator with npm run dev.</p>
            <Button onClick={() => refreshRef.current()}>Retry</Button>
          </div>
        ) : null}
      </main>
    );
  const tasks = data.tasks.filter((task) => task.projectId === project?.id),
    gates = data.gates.filter(
      (gate) => gate.projectId === project?.id && gate.status === "open",
    );
  const runs = data.runs.filter((run) => run.projectId === project?.id),
    messages = data.messages.filter(
      (message) => message.projectId === project?.id,
    );
  const active = runs.filter((run) => run.status === "running");
  return (
    <div className="app">
      {onboarding ? (
        <Onboarding
          data={data}
          onDone={(id) => {
            setSelectedId(id);
            setOnboarding(false);
            setView("goal");
            void refreshRef.current();
          }}
          onBack={data.projects.length ? () => setOnboarding(false) : undefined}
          refresh={() => refreshRef.current()}
        />
      ) : (
        <>
          <aside className="sidebar">
            <a
              className="wordmark"
              href="#"
              onClick={(event) => {
                event.preventDefault();
                setView("goal");
              }}
            >
              <img src="/brand/looproom-mark-reverse.svg" alt="" />
              looproom
            </a>
            <label className="sr-only" htmlFor="project-picker">
              Project
            </label>
            <select
              id="project-picker"
              value={project?.id ?? ""}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setView("goal");
              }}
              className="project-picker"
            >
              {data.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <nav aria-label="Workspace">
              {NAV.map((item) => (
                <button
                  key={item.id}
                  className={view === item.id ? "selected" : ""}
                  onClick={() => setView(item.id)}
                  aria-current={view === item.id ? "page" : undefined}
                >
                  <item.icon size={17} />
                  {item.label}
                  {item.id === "review" && gates.length ? (
                    <span className="nav-count">{gates.length}</span>
                  ) : null}
                </button>
              ))}
            </nav>
            <button className="new-project" onClick={() => setOnboarding(true)}>
              <Plus size={16} />
              New project
            </button>
            <div className="sidebar-bottom">
              <p>
                <span
                  className={
                    "connection-dot " +
                    (data.runtime.account?.type === "chatgpt"
                      ? "connected"
                      : "")
                  }
                />
                {data.runtime.account?.type === "chatgpt"
                  ? "ChatGPT connected"
                  : "Account needed"}
              </p>
              <button
                onClick={() => setView("settings")}
                className={view === "settings" ? "selected" : ""}
              >
                <Settings2 size={17} />
                Settings
              </button>
              <div className="local-label">
                Local on this Mac <ShieldCheck size={13} />
              </div>
            </div>
          </aside>
          <main className="workspace">
            <header className="topbar">
              <div className="breadcrumb">
                <FolderGit2 size={16} />
                <span>{project?.name}</span>
                <ChevronRight size={13} />
                <span>
                  {NAV.find((item) => item.id === view)?.label ?? "Settings"}
                </span>
              </div>
              {project ? (
                <div className="project-controls">
                  <span className={"status " + project.status}>
                    <span />
                    {statusText(project.status)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      act(() =>
                        api("/projects/" + project.id + "/control", {
                          action:
                            project.status === "running" ? "pause" : "start",
                        }),
                      )
                    }
                  >
                    {project.status === "running" ? (
                      <Pause size={14} />
                    ) : (
                      <Play size={14} />
                    )}
                    {project.status === "running" ? "Pause" : "Start loop"}
                  </Button>
                </div>
              ) : null}
            </header>
            {error || connectionError ? (
              <div className="error-banner" role="alert">
                <span>{error || connectionError}</span>
                <button
                  aria-label="Dismiss error"
                  onClick={() => {
                    setError("");
                    setConnectionError("");
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            ) : null}
            {!project ? (
              <Empty
                title="Your first project"
                text="Connect a repository and give the agents a clear outcome."
              >
                <Button onClick={() => setOnboarding(true)}>
                  Create project
                </Button>
              </Empty>
            ) : (
              <>
                {view === "goal" ? (
                  <Goal
                    project={project}
                    messages={messages}
                    active={active}
                    tasks={tasks}
                    gates={gates}
                    act={act}
                    busy={busy}
                    openReview={() => setView("review")}
                    openTask={setInspect}
                  />
                ) : null}
                {view === "work" ? (
                  <Work tasks={tasks} onSelect={setInspect} />
                ) : null}
                {view === "room" ? (
                  <Room
                    runs={runs}
                    tasks={tasks}
                    settings={data.settings}
                    events={data.events.filter(
                      (event) => event.project_id === project.id,
                    )}
                  />
                ) : null}
                {view === "review" ? (
                  <ReviewInbox
                    gates={gates}
                    tasks={tasks}
                    act={act}
                    busy={busy}
                  />
                ) : null}
                {view === "memory" ? (
                  <Memory
                    project={project}
                    pages={data.memory.filter(
                      (page) => page.projectId === project.id,
                    )}
                  />
                ) : null}
                {view === "settings" ? (
                  <Settings
                    data={data}
                    project={project}
                    act={act}
                    busy={busy}
                    refresh={() => refreshRef.current()}
                  />
                ) : null}
              </>
            )}
          </main>
        </>
      )}
      <TaskDetail
        task={
          inspect
            ? (data.tasks.find((task) => task.id === inspect.id) ?? inspect)
            : null
        }
        onClose={() => setInspect(null)}
      />
    </div>
  );
}

const initialDraft = {
  step: 1,
  mode: "existing",
  path: "",
  name: "",
  goal: "",
  constraints:
    "Require human approval for every PR merge. Work only toward this goal.",
  checks: "npm run build",
  connectLater: false,
};
function Onboarding({
  data,
  onDone,
  onBack,
  refresh,
}: {
  data: Data;
  onDone: (id: string) => void;
  onBack?: () => void;
  refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => {
    try {
      return {
        ...initialDraft,
        ...JSON.parse(localStorage.getItem("looproom.onboarding.v1") ?? "{}"),
      };
    } catch {
      return initialDraft;
    }
  });
  const [repo, setRepo] = useState<any>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [authUrl, setAuthUrl] = useState("");
  useEffect(
    () => localStorage.setItem("looproom.onboarding.v1", JSON.stringify(draft)),
    [draft],
  );
  const update = (key: string, value: string | boolean) => {
    setDraft((draft: any) => ({ ...draft, [key]: value }));
    if (["path", "mode"].includes(key)) setRepo(null);
  };
  async function inspect() {
    setPending(true);
    setError("");
    try {
      const result = await api("/repos/inspect", {
        path: draft.path,
        mode: draft.mode,
      });
      setRepo(result);
      if (!draft.name) update("name", result.path.split("/").pop());
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function connect() {
    setPending(true);
    setError("");
    try {
      const result = await api("/runtime/login", {});
      const url = new URL(result.authUrl);
      if (
        !["auth.openai.com", "chatgpt.com", "auth.chatgpt.com"].includes(
          url.hostname,
        )
      )
        throw new Error("Unexpected sign-in address.");
      setAuthUrl(url.href);
      window.open(url.href, "_blank", "noopener,noreferrer");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function create() {
    setPending(true);
    setError("");
    try {
      const project = await api("/projects", {
        ...draft,
        checks: draft.checks
          .split("\n")
          .map((line: string) => line.trim())
          .filter(Boolean),
      });
      localStorage.removeItem("looproom.onboarding.v1");
      onDone(project.id);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  }
  const account = data.runtime.account;
  const disabled =
    pending ||
    (draft.step === 1 && !repo) ||
    (draft.step === 2 && account?.type !== "chatgpt" && !draft.connectLater) ||
    (draft.step === 3 && (draft.goal.trim().length < 5 || !draft.name.trim()));
  return (
    <main className="onboarding">
      <header>
        <a className="wordmark light" href="#">
          <img src="/brand/looproom-mark.svg" alt="" />
          looproom
        </a>
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft size={14} />
            Back to workspace
          </Button>
        ) : (
          <span className="local-label">Your work. Your Mac.</span>
        )}
      </header>
      <div className="onboarding-layout">
        <section className="welcome">
          <div className="welcome-copy">
            <h1>
              Give good work
              <br />
              room to happen.
            </h1>
            <p>
              A clear goal. Agents that move it forward.
              <br />
              Your judgment at the moments that matter.
            </p>
          </div>
          <img
            className="brand-sculpture"
            src="/brand/brand-sculpture.png"
            alt="Two continuous graphite and teal loops meeting at a vermilion gate"
          />
          <div className="onboarding-promise">
            <ShieldCheck size={18} />
            <p>
              Code stays in isolated worktrees.
              <br />
              Every merge waits for your approval.
            </p>
          </div>
        </section>
        <section className="setup" aria-label="Project setup">
          <Stepper
            initialStep={draft.step}
            onStepChange={(step) =>
              setDraft((draft: any) => ({ ...draft, step }))
            }
            disableStepIndicators
            stepCircleContainerClassName="setup-frame"
            stepContainerClassName="setup-progress"
            contentClassName="setup-content"
            footerClassName="setup-footer"
            nextButtonText="Continue"
            finalButtonText="Create project"
            nextButtonProps={{
              disabled,
              className: "setup-next",
              ...(draft.step === 4 ? { onClick: create } : {}),
            }}
            backButtonProps={{ disabled: pending, className: "setup-back" }}
            renderStepIndicator={({ step, currentStep }) => (
              <span
                className={
                  "step-number " +
                  (step === currentStep
                    ? "active"
                    : step < currentStep
                      ? "complete"
                      : "")
                }
                aria-current={step === currentStep ? "step" : undefined}
              >
                {step < currentStep ? <Check size={13} /> : step}
              </span>
            )}
          >
            <Step>
              <div className="step-heading">
                <p>01 / Project</p>
                <h2>Where will we work?</h2>
                <p>Open a repository or start a new project.</p>
              </div>
              <div className="mode-picker">
                <button
                  className={draft.mode === "existing" ? "active" : ""}
                  onClick={() => update("mode", "existing")}
                >
                  Existing repository
                </button>
                <button
                  className={draft.mode === "new" ? "active" : ""}
                  onClick={() => update("mode", "new")}
                >
                  New project
                </button>
              </div>
              <label htmlFor="repo-path">
                {draft.mode === "new"
                  ? "New project folder"
                  : "Repository folder"}
              </label>
              <Input
                id="repo-path"
                autoFocus
                placeholder="/Users/you/Projects/my-app"
                value={draft.path}
                onChange={(event) => update("path", event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void inspect();
                }}
              />
              <Button
                variant="outline"
                onClick={inspect}
                disabled={pending || !draft.path}
              >
                {pending ? "Checking folder…" : "Check folder"}
                <ArrowRight size={14} />
              </Button>
              {repo ? (
                <div className="repo-confirmed">
                  <Check size={15} />
                  <div>
                    <strong>{repo.path.split("/").pop()}</strong>
                    <span>
                      {repo.branch}
                      {repo.remote
                        ? " · GitHub remote detected"
                        : " · Connect GitHub when a PR is ready"}
                    </span>
                    {repo.dirty ? (
                      <span>
                        Agents will start from the committed revision.
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </Step>
            <Step>
              <div className="step-heading">
                <p>02 / Runtime</p>
                <h2>Connect your agents.</h2>
                <p>Use your ChatGPT plan through the local Codex runtime.</p>
              </div>
              <div className="account-row">
                <span
                  className={
                    "connection-dot " +
                    (account?.type === "chatgpt" ? "connected" : "")
                  }
                />
                <div>
                  <strong>
                    {account?.type === "chatgpt"
                      ? "ChatGPT connected"
                      : "ChatGPT account"}
                  </strong>
                  <span>
                    {account?.email ?? "Sign in securely in your browser"}
                  </span>
                </div>
              </div>
              {account?.type !== "chatgpt" ? (
                <Button onClick={connect} disabled={pending}>
                  Continue with ChatGPT
                  <ExternalLink size={14} />
                </Button>
              ) : (
                <p className="success-text">
                  <Check size={14} />
                  Ready to connect your first goal
                </p>
              )}
              {authUrl ? (
                <p className="auth-help">
                  <a href={authUrl} target="_blank" rel="noreferrer">
                    Open sign-in again
                  </a>
                  <button onClick={refresh}>I’ve signed in · Refresh</button>
                </p>
              ) : null}
              <div className="model-summary">
                <div>
                  <span>Orchestrator</span>
                  <strong>{data.settings.orchestrator.model}</strong>
                  <small>{data.settings.orchestrator.effort} reasoning</small>
                </div>
                <div>
                  <span>Workers</span>
                  <strong>{data.settings.subagent.model}</strong>
                  <small>{data.settings.subagent.effort} reasoning</small>
                </div>
              </div>
              <p className="field-help">
                Model access is confirmed by the first completed run. Change
                defaults later in Settings.
              </p>
              {data.runtime.error ? (
                <p className="field-error">{data.runtime.error}</p>
              ) : null}
              {account?.type !== "chatgpt" ? (
                <label className="connect-later">
                  <input
                    type="checkbox"
                    checked={draft.connectLater}
                    onChange={(event) =>
                      update("connectLater", event.target.checked)
                    }
                  />
                  Set up my account later
                </label>
              ) : null}
            </Step>
            <Step>
              <div className="step-heading">
                <p>03 / Goal</p>
                <h2>What should get better?</h2>
                <p>Describe the outcome. Agents will research the path.</p>
              </div>
              <label htmlFor="project-name">Project name</label>
              <Input
                id="project-name"
                value={draft.name}
                onChange={(event) => update("name", event.target.value)}
              />
              <label htmlFor="project-goal">Your goal</label>
              <Textarea
                id="project-goal"
                rows={5}
                value={draft.goal}
                onChange={(event) => update("goal", event.target.value)}
                placeholder="Build a workshop booking app that feels clear, fast, and welcoming. Organizers should manage sessions; visitors should reserve a place."
              />
              <label htmlFor="project-constraints">Boundaries</label>
              <Textarea
                id="project-constraints"
                rows={2}
                value={draft.constraints}
                onChange={(event) => update("constraints", event.target.value)}
              />
            </Step>
            <Step>
              <div className="step-heading">
                <p>04 / Ready</p>
                <h2>A useful first step.</h2>
                <p>Start with a sourced plan. Then move into implementation.</p>
              </div>
              <dl className="setup-review">
                <dt>Project</dt>
                <dd>{draft.name}</dd>
                <dt>Folder</dt>
                <dd className="mono">{draft.path}</dd>
                <dt>Goal</dt>
                <dd>{draft.goal}</dd>
              </dl>
              <label htmlFor="setup-checks">
                Acceptance checks · one command per line
              </label>
              <Textarea
                id="setup-checks"
                rows={2}
                value={draft.checks}
                onChange={(event) => update("checks", event.target.value)}
              />
              <p className="field-help">
                These are commands you authorize in isolated worktrees. Leave
                blank while researching; add before publishing code.
              </p>
              <p className="approval-note">
                <Square size={12} />
                Every PR is yours to review and merge.
              </p>
            </Step>
          </Stepper>
          {error ? (
            <p className="setup-error" role="alert">
              {error}
            </p>
          ) : null}
          {pending ? (
            <div className="setup-loading">
              <Pending
                label={
                  draft.step === 4 ? "Creating your workspace" : "Connecting"
                }
              />
            </div>
          ) : null}
        </section>
      </div>
      <footer>Continuous work, with a human point of rest.</footer>
    </main>
  );
}

function Goal({
  project,
  messages,
  active,
  tasks,
  gates,
  act,
  busy,
  openReview,
  openTask,
}: any) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [messages.length]);
  function send(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    const value = text;
    void act(async () => {
      await api("/projects/" + project.id + "/messages", { text: value });
      setText("");
    });
  }
  return (
    <div className="goal-layout">
      <section className="conversation">
        <div className="page-intro">
          <div className="repo-line">
            <GitBranch size={13} />
            {project.branch}
            <span>·</span>
            <span>Goal conversation</span>
          </div>
          <h1>{project.name}</h1>
          <p>Move the goal forward. Keep the evidence close.</p>
        </div>
        <div className="messages">
          {messages.map((message: any) => (
            <article key={message.id} className={"message " + message.role}>
              <div className="message-byline">
                {message.role === "human" ? (
                  <span className="human-avatar">You</span>
                ) : (
                  <img src="/brand/looproom-mark.svg" alt="" />
                )}
                <strong>
                  {message.role === "human" ? "You" : "Orchestrator"}
                </strong>
                <DateLabel date={message.createdAt} />
              </div>
              <div className="message-body">{message.text}</div>
            </article>
          ))}
          {active.map((run: any) => (
            <article key={run.id} className="message live">
              <div className="message-byline">
                <Orb active size={34} identity={run.role} />
                <strong>{run.role}</strong>
                <span className="live-label">Thinking</span>
              </div>
              <div className="message-body">
                <Pending
                  label={
                    run.activity === "fileChange"
                      ? "Updating the assigned worktree"
                      : run.activity === "commandExecution"
                        ? "Running a command in the project"
                        : run.activity === "webSearch"
                          ? "Checking source evidence"
                          : run.role === "orchestrator"
                            ? "Reading the project and finding the first useful step"
                            : "Working on the assigned task"
                  }
                />
              </div>
            </article>
          ))}
          {!active.length && !tasks.length ? (
            <div className="first-step">
              <h2>Your goal is ready.</h2>
              <p>
                Start the loop to get a sourced plan. Agents will implement in
                worktrees and bring PRs back here for review.
              </p>
              <Button
                disabled={busy}
                onClick={() =>
                  act(() =>
                    api("/projects/" + project.id + "/control", {
                      action: "start",
                    }),
                  )
                }
              >
                <Play size={14} />
                Start planning
              </Button>
            </div>
          ) : null}
          {gates.length ? (
            <button className="inline-gate" onClick={openReview}>
              <span className="gate-square" />
              <div>
                <strong>
                  {gates.length === 1
                    ? gates[0].title
                    : gates.length + " decisions need you"}
                </strong>
                <p>{gates[0].detail?.slice(0, 160)}</p>
              </div>
              <ArrowRight size={17} />
            </button>
          ) : null}
          <div ref={end} />
        </div>
        <form className="composer" onSubmit={send}>
          <label className="sr-only" htmlFor="message">
            Message your agents
          </label>
          <Textarea
            id="message"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Add context, clarify the goal, or leave a direction…"
            rows={2}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                send(event);
            }}
          />
          <div>
            <span>⌘ Enter to send · Context stays with this project</span>
            <Button type="submit" disabled={busy || !text.trim()} size="sm">
              Send
              <ArrowRight size={14} />
            </Button>
          </div>
        </form>
      </section>
      <aside className="goal-context">
        <h2>In motion</h2>
        {active.length ? (
          active.map((run: any) => (
            <div className="context-agent" key={run.id}>
              <Orb active />
              <div>
                <strong>{run.role}</strong>
                <span>{run.model}</span>
                <small>{run.effort} reasoning</small>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">
            Agents are{" "}
            {project.status === "paused"
              ? "paused"
              : gates.length
                ? "waiting at a gate"
                : "idle"}
            .
          </p>
        )}
        <div className="context-heading">
          <h2>Work frontier</h2>
          <span>
            {tasks.filter((task: any) => task.status === "completed").length} /{" "}
            {tasks.length}
          </span>
        </div>
        {tasks.length ? (
          tasks.slice(-6).map((task: any) => (
            <button
              className="context-task"
              onClick={() => openTask(task)}
              key={task.id}
            >
              <StatusMark
                status={glyph(task.status)}
                size={17}
                label=""
                color="#167a72"
                doneColor="#25724b"
              />
              <div>
                <strong>{task.title}</strong>
                <span>{statusText(task.status)}</span>
              </div>
            </button>
          ))
        ) : (
          <p className="muted">
            The first plan will create a small set of useful tasks.
          </p>
        )}
        <div className="context-authority">
          <Square size={13} />
          <p>
            Human approval
            <br />
            <strong>Required for every merge</strong>
          </p>
        </div>
      </aside>
    </div>
  );
}

function Work({
  tasks,
  onSelect,
}: {
  tasks: any[];
  onSelect: (task: any) => void;
}) {
  const [view, setView] = useState("list");
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>Work</h1>
          <p>Useful steps, explicit dependencies.</p>
        </div>
        <div className="mode-picker compact">
          <button
            className={view === "list" ? "active" : ""}
            onClick={() => setView("list")}
          >
            List
          </button>
          <button
            className={view === "graph" ? "active" : ""}
            onClick={() => setView("graph")}
          >
            Dependencies
          </button>
        </div>
      </div>
      {!tasks.length ? (
        <Empty
          title="A plan comes first"
          text="Start the goal loop. The orchestrator will turn the outcome into bounded, verifiable tasks."
        />
      ) : view === "graph" ? (
        <DependencyGraph tasks={tasks} onSelect={onSelect} />
      ) : (
        <div className={"work-list " + view}>
          <div className="work-header">
            <span>Task</span>
            <span>State</span>
            <span>Dependencies</span>
            <span>Evidence</span>
          </div>
          {tasks.map((task) => (
            <button
              className="work-row"
              key={task.id}
              onClick={() => onSelect(task)}
            >
              <div className="work-title">
                <StatusMark
                  status={glyph(task.status)}
                  label=""
                  size={20}
                  color="#167a72"
                  doneColor="#25724b"
                />
                <div>
                  <strong>{task.title}</strong>
                  <small>
                    {task.kind} · {task.id.slice(0, 8)}
                  </small>
                </div>
              </div>
              <span className={"status " + task.status}>
                {statusText(task.status)}
              </span>
              <span className="dependencies">
                {task.dependencies.length
                  ? task.dependencies
                      .map(
                        (id: string) =>
                          tasks.find((t) => t.id === id)?.title ?? id,
                      )
                      .join(" → ")
                  : "Ready frontier"}
              </span>
              <span>
                {task.pr ? (
                  <>
                    <GitPullRequest size={14} />
                    PR ready
                  </>
                ) : task.checks?.length ? (
                  task.checks.filter((c: any) => c.code === 0).length +
                  " checks passed"
                ) : (
                  "—"
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Room({ runs, tasks, settings, events }: any) {
  const roles = ["orchestrator", "implementation", "review", "research"];
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>Agent room</h1>
          <p>One shared goal. Clear ownership and handoffs.</p>
        </div>
        <span className="mono">Local runtime</span>
      </div>
      <div className="agent-room">
        {roles.map((role) => {
          const active = runs.find(
            (r: any) => r.role === role && r.status === "running",
          );
          const latest = runs.filter((r: any) => r.role === role).at(-1);
          const profile =
            role === "orchestrator" ? settings.orchestrator : settings.subagent;
          const task = tasks.find((t: any) => t.id === active?.taskId);
          return (
            <article className="agent-row" key={role}>
              <Orb active={!!active} size={76} identity={role} />
              <div className="agent-info">
                <h2>{role[0].toUpperCase() + role.slice(1)}</h2>
                <p>
                  {task?.title ??
                    (active
                      ? "Researching the next useful step"
                      : latest?.error
                        ? "Last run needs attention"
                        : "Waiting for assigned work")}
                </p>
                <span className="mono">
                  {profile.model} · {profile.effort}
                </span>
              </div>
              <span className={"status " + (active ? "running" : "idle")}>
                <span />
                {active ? "Thinking" : "Idle"}
              </span>
            </article>
          );
        })}
      </div>
      <div className="section-heading">
        <h2>Handoffs and events</h2>
        <span>Recorded by the coordinator</span>
      </div>
      {events.length ? (
        <ol className="event-list">
          {events.slice(0, 25).map((event: any) => (
            <li key={event.seq}>
              <span
                className={
                  event.type.includes("gate") ? "gate-square" : "event-dot"
                }
              />
              <div>
                <strong>{event.type.replaceAll("-", " ")}</strong>
                <p>
                  {event.data.title ??
                    event.data.command ??
                    event.data.summary ??
                    event.data.role ??
                    event.data.pr ??
                    "Project state recorded"}
                </p>
              </div>
              <DateLabel date={event.created_at} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">Real handoffs will appear after the first run.</p>
      )}
    </section>
  );
}

function ReviewInbox({ gates, tasks, act, busy }: any) {
  const [selected, setSelected] = useState<string>(""),
    [answer, setAnswer] = useState(""),
    [pr, setPr] = useState<any>(null),
    [diff, setDiff] = useState(""),
    [loadError, setLoadError] = useState(""),
    [confirm, setConfirm] = useState(false),
    [loading, setLoading] = useState(false);
  const gate = gates.find((gate: any) => gate.id === selected) ?? gates[0];
  const task = tasks.find((task: any) => task.id === gate?.taskId);
  useEffect(() => {
    setPr(null);
    setDiff("");
    setAnswer("");
    setLoadError("");
    if (!gate || gate.type !== "pr") return;
    let alive = true;
    setLoading(true);
    Promise.all([
      api("/gates/" + gate.id + "/pr"),
      api("/gates/" + gate.id + "/diff"),
    ])
      .then(([info, file]) => {
        if (alive) {
          setPr(info);
          setDiff(file.diff);
        }
      })
      .catch((error) => {
        if (alive) setLoadError(error.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [gate?.id, gate?.sha]);
  if (!gates.length)
    return (
      <section className="page">
        <h1>Review</h1>
        <Empty
          title="Nothing needs your judgment."
          text="Agents will bring a decision here when they need your authority, access, or a PR merge."
        />
      </section>
    );
  return (
    <section className="page review-page">
      <div className="page-heading">
        <div>
          <h1>Review</h1>
          <p>
            {gates.length} {gates.length === 1 ? "decision" : "decisions"}{" "}
            waiting for you.
          </p>
        </div>
        <span className="approval-note">
          <Square size={12} />
          Human gate
        </span>
      </div>
      <div className="review-layout">
        <div className="review-queue">
          {gates.map((item: any) => (
            <button
              key={item.id}
              className={item.id === gate.id ? "active" : ""}
              onClick={() => setSelected(item.id)}
            >
              <span className="gate-square" />
              <div>
                <strong>{item.title}</strong>
                <span>
                  {tasks.find((task: any) => task.id === item.taskId)?.title ??
                    "Project direction"}
                </span>
              </div>
            </button>
          ))}
        </div>
        <article className="review-document">
          <div className="repo-line">
            {gate.type === "pr" ? "Pull request" : "Decision"}
            <span>·</span>
            <DateLabel date={gate.createdAt} />
          </div>
          <h2>{task?.title ?? gate.title}</h2>
          <p className="review-summary">{gate.detail}</p>
          {gate.type === "pr" ? (
            <>
              <a
                className="source-link"
                href={gate.pr}
                target="_blank"
                rel="noreferrer"
              >
                Open PR on GitHub
                <ExternalLink size={13} />
              </a>
              {loading ? (
                <Pending label="Fetching the current PR revision and diff" />
              ) : null}
              {loadError ? (
                <p className="field-error" role="alert">
                  {loadError}
                </p>
              ) : null}
              {pr ? (
                <>
                  <dl className="revision">
                    <dt>Reviewed commit</dt>
                    <dd className="mono">{pr.headRefOid}</dd>
                    <dt>GitHub state</dt>
                    <dd>
                      {pr.state} · {pr.mergeable}
                    </dd>
                  </dl>
                  {pr.headRefOid !== gate.sha ? (
                    <p className="field-error">
                      Revision changed. Request changes so agents can verify and
                      publish the new commit.
                    </p>
                  ) : null}
                  <h3>Verification</h3>
                  <ul className="check-list">
                    {task?.checks?.map((check: any, i: number) => (
                      <li key={i}>
                        <Check size={15} />
                        <span className="mono">{check.command}</span>
                        <span>Exit {check.code}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="muted">
                    {pr.statusCheckRollup?.length ?? 0} GitHub checks reported.
                    GitHub branch rules also apply at merge.
                  </p>
                  <h3>Independent review</h3>
                  <p>{task?.review?.summary}</p>
                  <h3>Changed files</h3>
                  <ul className="file-list">
                    {pr.files?.map((file: any) => (
                      <li key={file.path}>
                        <span className="mono">{file.path}</span>
                        <span className="diff-count">
                          +{file.additions} −{file.deletions}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <details>
                    <summary>Read the full diff</summary>
                    <pre className="diff">{diff || "No diff returned."}</pre>
                  </details>
                  <Button
                    className="merge-button"
                    disabled={
                      busy ||
                      pr.headRefOid !== gate.sha ||
                      pr.state !== "OPEN" ||
                      pr.mergeable !== "MERGEABLE"
                    }
                    onClick={() => setConfirm(true)}
                  >
                    <GitPullRequest size={15} />
                    Approve & merge
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
          <div className="decision-response">
            <label htmlFor="gate-answer">
              {gate.type === "pr"
                ? "Request changes"
                : "Your decision or resolution"}
            </label>
            <Textarea
              id="gate-answer"
              rows={3}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder={
                gate.type === "pr"
                  ? "Describe what should change before merging…"
                  : "Answer the question, or describe what you fixed…"
              }
            />
            <div className="response-actions">
              <Button
                variant="outline"
                disabled={busy || !answer.trim()}
                onClick={() =>
                  act(() =>
                    api("/gates/" + gate.id + "/resolve", {
                      answer,
                      retry: true,
                    }),
                  )
                }
              >
                {gate.type === "pr" ? "Request changes" : "Resolve & retry"}
                <ArrowRight size={14} />
              </Button>
              {gate.taskId && gate.type !== "pr" ? (
                <Button
                  variant="ghost"
                  disabled={busy || !answer.trim()}
                  onClick={() =>
                    act(() =>
                      api("/gates/" + gate.id + "/resolve", {
                        answer,
                        retry: false,
                      }),
                    )
                  }
                >
                  Skip this task
                </Button>
              ) : null}
            </div>
          </div>
        </article>
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge this revision?</DialogTitle>
            <DialogDescription>
              This merges the reviewed pull request on GitHub. Looproom will
              check the commit again before submitting the merge.
            </DialogDescription>
          </DialogHeader>
          <p className="mono confirm-sha">{pr?.headRefOid}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Keep reviewing
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await api("/gates/" + gate.id + "/approve", {
                    sha: pr.headRefOid,
                  });
                  setConfirm(false);
                })
              }
            >
              Approve & merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Memory({ project, pages }: any) {
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<any[] | null>(null),
    [error, setError] = useState("");
  async function search(event: FormEvent) {
    event.preventDefault();
    try {
      setResults(
        await api(
          "/projects/" + project.id + "/memory?q=" + encodeURIComponent(query),
        ),
      );
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <section className="page reading-page">
      <div className="page-heading">
        <div>
          <h1>Project memory</h1>
          <p>Outcomes, sources, and a history that survives restarts.</p>
        </div>
        <span className="mono">SQLite FTS5 + LLM wiki</span>
      </div>
      <form onSubmit={search} className="memory-search">
        <label className="sr-only" htmlFor="memory-query">
          Search project memory
        </label>
        <Input
          id="memory-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search decisions, findings, and outcomes"
        />
        <Button variant="outline" type="submit">
          <Search size={15} />
          Search
        </Button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {(results ?? pages).length ? (
        (results ?? pages).map((page: any) => (
          <article className="memory-document" key={page.id}>
            <h2>{page.title}</h2>
            <p>{page.content}</p>
            <div className="evidence">
              <strong>Agent-reported outcome</strong>
              <span>Verification lives with the task and PR.</span>
            </div>
            {page.sources?.length ? (
              <ul>
                {page.sources.map((source: string, i: number) => (
                  <li key={i}>
                    <span className="source-marker">[{i + 1}]</span>
                    {/^https:\/\//.test(source) ? (
                      <a href={source} target="_blank" rel="noreferrer">
                        {source}
                      </a>
                    ) : (
                      <span className="mono">{source}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No external sources cited.</p>
            )}
          </article>
        ))
      ) : (
        <Empty
          title={
            query
              ? "No matching memory yet."
              : "Knowledge starts with evidence."
          }
          text="Completed agent runs will create Markdown pages, source records, an index, and an append-only log."
        />
      )}
    </section>
  );
}

function Settings({ data, project, act, busy, refresh }: any) {
  const [settings, setSettings] = useState(data.settings),
    [checks, setChecks] = useState(project.checks.join("\n")),
    [constraints, setConstraints] = useState(project.constraints),
    [authUrl, setAuthUrl] = useState("");
  useEffect(() => {
    setChecks(project.checks.join("\n"));
    setConstraints(project.constraints);
  }, [project.id]);
  async function login() {
    const result = await api("/runtime/login", {});
    const url = new URL(result.authUrl);
    if (
      !["auth.openai.com", "chatgpt.com", "auth.chatgpt.com"].includes(
        url.hostname,
      )
    )
      throw new Error("Unexpected sign-in address.");
    setAuthUrl(url.href);
    window.open(url.href, "_blank", "noopener,noreferrer");
  }
  const models = [
    ...new Map(
      [
        ...data.runtime.models.map((model: any) => ({
          model: model.model,
          displayName: model.displayName,
        })),
        {
          model: settings.orchestrator.model,
          displayName: settings.orchestrator.model,
        },
        {
          model: settings.subagent.model,
          displayName: settings.subagent.model,
        },
      ].map((model: any) => [model.model, model]),
    ).values(),
  ] as any[];
  return (
    <section className="page settings-page">
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>Choose how the room works.</p>
        </div>
      </div>
      <section className="setting-section">
        <h2>ChatGPT connection</h2>
        <div className="account-row">
          <span
            className={
              "connection-dot " +
              (data.runtime.account?.type === "chatgpt" ? "connected" : "")
            }
          />
          <div>
            <strong>
              {data.runtime.account?.type === "chatgpt"
                ? "Connected"
                : "Sign-in required"}
            </strong>
            <span>
              {data.runtime.account?.email ??
                data.runtime.error ??
                "Local Codex runtime · isolated Looproom account storage"}
            </span>
          </div>
        </div>
        <div className="response-actions">
          <Button variant="outline" disabled={busy} onClick={() => act(login)}>
            Sign in with ChatGPT
            <ExternalLink size={14} />
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              act(async () => {
                await api("/runtime/connect", {});
                await refresh();
              })
            }
          >
            Refresh connection
          </Button>
        </div>
        {authUrl ? (
          <a
            className="source-link"
            href={authUrl}
            target="_blank"
            rel="noreferrer"
          >
            Continue sign-in
            <ExternalLink size={13} />
          </a>
        ) : null}
      </section>
      <section className="setting-section">
        <h2>Models</h2>
        <p>Defaults apply to future runs. Unavailable models create a gate.</p>
        {(["orchestrator", "subagent"] as const).map((role) => (
          <div className="model-setting" key={role}>
            <label htmlFor={role + "-model"}>
              {role === "orchestrator"
                ? "Orchestrator"
                : "Implementation & subagents"}
            </label>
            <select
              id={role + "-model"}
              value={settings[role].model}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  [role]: { ...settings[role], model: event.target.value },
                })
              }
            >
              {models.map((model) => (
                <option key={model.model} value={model.model}>
                  {model.displayName}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor={role + "-effort"}>
              {role} reasoning effort
            </label>
            <select
              id={role + "-effort"}
              value={settings[role].effort}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  [role]: { ...settings[role], effort: event.target.value },
                })
              }
            >
              {["low", "medium", "high", "xhigh", "max"].map((effort) => (
                <option key={effort} value={effort}>
                  {effort} reasoning
                </option>
              ))}
            </select>
          </div>
        ))}
        <label htmlFor="concurrency">Concurrent project runs</label>
        <Input
          id="concurrency"
          type="number"
          min={1}
          max={4}
          value={settings.concurrency}
          onChange={(event) =>
            setSettings({
              ...settings,
              concurrency: Number(event.target.value),
            })
          }
          className="short-input"
        />
        <Button
          disabled={busy}
          onClick={() =>
            act(() =>
              api("/settings", {
                orchestrator: settings.orchestrator,
                subagent: settings.subagent,
                concurrency: settings.concurrency,
              }),
            )
          }
        >
          Save model settings
        </Button>
      </section>
      <section className="setting-section">
        <h2>Project boundaries</h2>
        <label htmlFor="settings-constraints">Scope and exclusions</label>
        <Textarea
          id="settings-constraints"
          rows={3}
          value={constraints}
          onChange={(event) => setConstraints(event.target.value)}
        />
        <label htmlFor="settings-checks">
          Authorized checks · one command per line
        </label>
        <Textarea
          id="settings-checks"
          rows={3}
          value={checks}
          onChange={(event) => setChecks(event.target.value)}
        />
        <p className="field-help">
          Commands run through the Codex workspace sandbox with direct network
          disabled. Package installation may need a human step.
        </p>
        <Button
          disabled={busy}
          onClick={() =>
            act(() =>
              api("/projects/" + project.id + "/settings", {
                checks: checks
                  .split("\n")
                  .map((line: string) => line.trim())
                  .filter(Boolean),
                constraints,
              }),
            )
          }
        >
          Save project settings
        </Button>
      </section>
      <section className="setting-section">
        <h2>Control</h2>
        <p>
          Pausing interrupts active agent turns. Worktrees and evidence remain
          available.
        </p>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            act(() =>
              api("/projects/" + project.id + "/control", { action: "stop" }),
            )
          }
        >
          <Square size={13} />
          Stop project
        </Button>
      </section>
    </section>
  );
}

function TaskDetail({ task, onClose }: { task: any; onClose: () => void }) {
  return (
    <Dialog
      open={!!task}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="task-dialog">
        <DialogHeader>
          <DialogTitle>{task?.title}</DialogTitle>
          <DialogDescription>
            {task ? statusText(task.status) + " · " + task.kind : ""}
          </DialogDescription>
        </DialogHeader>
        {task ? (
          <div className="task-document">
            <p>{task.description}</p>
            <h3>Acceptance</h3>
            <ul>
              {task.acceptance.map((line: string, i: number) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
            {task.worktree ? (
              <>
                <h3>Worktree</h3>
                <p className="mono">{task.worktree}</p>
              </>
            ) : null}
            {task.summary ? (
              <>
                <h3>Outcome</h3>
                <p>{task.summary}</p>
              </>
            ) : null}
            {task.checks?.map((check: any, i: number) => (
              <details key={i}>
                <summary className="mono">
                  {check.command} · exit {check.code}
                </summary>
                <pre>{check.output}</pre>
              </details>
            ))}
            {task.pr ? (
              <a
                className="source-link"
                href={task.pr}
                target="_blank"
                rel="noreferrer"
              >
                Open pull request
                <ExternalLink size={13} />
              </a>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
