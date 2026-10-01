import JudgePending from "./components/JudgePending";
import { Badge } from "./components/ui/badge";
import {
  escalationMode,
  needsHumanReview,
  type EscalationMode,
} from "./lib/autonomy";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
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
  CornerDownRight,
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
import { Select } from "./components/ui/select";
import { Checkbox } from "./components/ui/checkbox";
import { Accordion } from "./components/arc/accordion/accordion";
import FolderPicker from "./components/FolderPicker";

import {
  NotificationCenter,
  NotificationSettings,
  useEscalations,
} from "./components/Notifications";
import { ToastStack } from "./components/arc/toast-stack/toast-stack";
import { NumberField } from "./components/arc/number-field/number-field";
import { ScrollArea } from "./components/arc/scroll-area/scroll-area";
import { Alert } from "./components/arc/alert/alert";
import { EmptyState } from "./components/arc/empty-state/empty-state";
import { ActionButton } from "./components/arc/action-button/action-button";
import { Skeleton } from "./components/ui/skeleton";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Dialog, DialogContent } from "./components/ui/dialog";
import { DotmSquare3 } from "./components/ui/dotm-square-3";
import Stepper, { Step } from "./components/ui/Stepper";
import StatusMark from "./components/ui/StatusMark";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "./components/ui/popover";
import ConversationMessages from "./components/ConversationMessages";
import { Switch } from "./components/ui/switch";
const Work = lazy(() => import("./components/Work"));
import { frontierState, frontierLabel } from "./lib/work";
import { api, type Data } from "./lib/api";

const Memory = lazy(() => import("./components/Memory"));
const Room = lazy(() => import("./components/AgentRoom"));
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
      <DotmSquare3 size={18} dotSize={3} color="var(--lr-signal)" />
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
    <EmptyState
      className="empty"
      title={title}
      description={text}
      action={children}
    />
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
  const taskOpener = useRef<HTMLElement | null>(null);
  function inspectTask(task: any) {
    taskOpener.current = document.activeElement as HTMLElement;
    setInspect(task);
  }
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
  async function act(fn: () => Promise<any>, rethrow = false) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await refreshRef.current();
    } catch (error) {
      setError((error as Error).message);
      if (rethrow) throw error;
    } finally {
      setBusy(false);
    }
  }
  useEscalations(data?.gates, data?.projects, (projectId: string) => {
    setSelectedId(projectId);
    setView("review");
  });
  if (!data)
    return (
      <main className="boot">
        <img src="/brand/looproom-mark.svg?v=3" alt="Looproom" />
        <Pending label="Opening your workspace" />
        {connectionError ? (
          <Alert tone="danger" title={connectionError}>
            <p>Start the local coordinator with npm run dev.</p>
            <Button onClick={() => refreshRef.current()}>Retry</Button>
          </Alert>
        ) : null}
      </main>
    );
  const tasks = data.tasks.filter((task) => task.projectId === project?.id),
    gates = data.gates.filter(
      (gate) =>
        gate.projectId === project?.id && needsHumanReview(gate, project ?? {}),
    );
  const runs = data.runs.filter((run) => run.projectId === project?.id),
    messages = data.messages.filter(
      (message) => message.projectId === project?.id,
    );
  const active = runs.filter((run) => run.status === "running");
  return (
    <div
      className={"app" + (!onboarding && view === "goal" ? " goal-view" : "")}
      data-view={view}
    >
      <ToastStack position="bottom-right" />
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
              <img src="/brand/looproom-mark-reverse.svg?v=3" alt="" />
              looproom
            </a>
            <Select
              label="Project"
              id="project-picker"
              className="project-picker"
              value={project?.id ?? ""}
              onValueChange={setSelectedId}
              options={data.projects.map((project) => ({
                value: project.id,
                label: project.name,
              }))}
            />
            <nav aria-label="Workspace">
              {NAV.map((item) => (
                <Button
                  variant="ghost"
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
                </Button>
              ))}
            </nav>
            <Button
              variant="ghost"
              className="new-project"
              onClick={() => setOnboarding(true)}
            >
              <Plus size={16} />
              New project
            </Button>
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
              <Button
                variant="ghost"
                onClick={() => setView("settings")}
                className={view === "settings" ? "selected" : ""}
              >
                <Settings2 size={17} />
                Settings
              </Button>
              <div className="local-label">
                Local on this Mac <ShieldCheck size={13} />
              </div>
            </div>
          </aside>
          <main
            className={"workspace" + (view === "goal" ? " goal-workspace" : "")}
          >
            <header className="topbar">
              <div className="breadcrumb">
                <FolderGit2 size={16} />
                <span>{project?.name}</span>
                <ChevronRight size={13} />
                <span>
                  {NAV.find((item) => item.id === view)?.label ?? "Settings"}
                </span>
              </div>
              <NotificationCenter
                gates={data.gates}
                projects={data.projects}
                onOpen={(id: string) => {
                  setSelectedId(id);
                  setView("review");
                }}
              />
              {project ? (
                <div className="project-controls">
                  {escalationMode(project) === "yolo" ? (
                    <Badge variant="secondary">YOLO</Badge>
                  ) : null}
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
              <Alert
                className="error-banner"
                tone="danger"
                title={error || connectionError}
                onDismiss={() => {
                  setError("");
                  setConnectionError("");
                }}
              />
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
                    key={project.id}
                    project={project}
                    messages={messages}
                    active={active}
                    tasks={tasks}
                    gates={gates}
                    historyGates={data.gates.filter(
                      (gate) => gate.projectId === project.id,
                    )}
                    act={act}
                    busy={busy}
                    openReview={() => setView("review")}
                    openTask={inspectTask}
                  />
                ) : null}
                {view === "work" ? (
                  <Suspense fallback={<Pending label="Opening Work" />}>
                    <Work
                      key={project.id}
                      tasks={tasks}
                      runs={runs}
                      messages={messages}
                      gates={data.gates.filter(
                        (gate) => gate.projectId === project.id,
                      )}
                      project={project}
                      onSelect={inspectTask}
                      onReview={() => setView("review")}
                      onGoal={() => setView("goal")}
                    />
                  </Suspense>
                ) : null}
                {view === "room" ? (
                  <Suspense fallback={<Pending label="Opening agent room" />}>
                    <Room
                      runs={runs}
                      tasks={tasks}
                      settings={data.settings}
                      onSelectTask={inspectTask}
                      events={data.events.filter(
                        (event) => event.project_id === project.id,
                      )}
                    />
                  </Suspense>
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
                  <Suspense
                    fallback={<Skeleton label="Opening memory" lines={4} />}
                  >
                    <Memory
                      key={project.id}
                      project={project}
                      pages={data.memory.filter(
                        (page) => page.projectId === project.id,
                      )}
                    />
                  </Suspense>
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
        tasks={data.tasks}
        onClose={() => setInspect(null)}
        restoreFocus={() => taskOpener.current?.focus()}
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
          <img src="/brand/looproom-mark.svg?v=3" alt="" />
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
            alt="Two continuous loops meeting at a human gate"
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
          >
            <Step>
              <div className="step-heading">
                <p>01 / Project</p>
                <h2>Where will we work?</h2>
                <p>Open a repository or start a new project.</p>
              </div>
              <div className="mode-picker">
                <Button
                  variant="ghost"
                  className={draft.mode === "existing" ? "active" : ""}
                  onClick={() => update("mode", "existing")}
                >
                  Existing repository
                </Button>
                <Button
                  variant="ghost"
                  className={draft.mode === "new" ? "active" : ""}
                  onClick={() => update("mode", "new")}
                >
                  New project
                </Button>
              </div>

              <FolderPicker
                value={draft.path}
                onChange={(path) => update("path", path)}
                mode={draft.mode}
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
                  <Button variant="ghost" onClick={refresh}>
                    I’ve signed in · Refresh
                  </Button>
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
                <Alert tone="danger" title={data.runtime.error} />
              ) : null}
              {account?.type !== "chatgpt" ? (
                <label className="connect-later">
                  <Checkbox
                    checked={draft.connectLater}
                    onCheckedChange={(checked) =>
                      update("connectLater", checked === true)
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
              <Input
                id="project-name"
                label="Project name"
                value={draft.name}
                onChange={(event) => update("name", event.target.value)}
              />
              <Textarea
                id="project-goal"
                label="Your goal"
                rows={5}
                value={draft.goal}
                onChange={(event) => update("goal", event.target.value)}
                placeholder="Build a workshop booking app that feels clear, fast, and welcoming. Organizers should manage sessions; visitors should reserve a place."
              />
              <Textarea
                id="project-constraints"
                label="Boundaries"
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
              <Textarea
                id="setup-checks"
                label="Acceptance checks · one command per line"
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
            <Alert
              tone="danger"
              title="Could not continue"
              className="setup-error"
            >
              {error}
            </Alert>
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
  historyGates,
  act,
  busy,
  openReview,
  openTask,
}: any) {
  const [text, setText] = useState("");
  const [replyId, setReplyId] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const replyGate = historyGates.find((gate: any) => gate.id === replyId);
  function reply(gate: any) {
    setReplyId(gate.id);
    input.current?.focus();
  }
  const chat = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  function latest() {
    if (chat.current) chat.current.scrollTop = chat.current.scrollHeight;
    follow.current = true;
    setShowLatest(false);
  }
  useLayoutEffect(latest, []);
  useLayoutEffect(() => {
    if (follow.current) latest();
  }, [messages.length, gates.length, active.length]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (follow.current) latest();
    });
    if (flow.current) observer.observe(flow.current);
    return () => observer.disconnect();
  }, []);
  function send(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    const value = text;
    void act(async () => {
      if (replyId)
        await api("/gates/" + replyId + "/resolve", {
          answer: value,
          retry: true,
        });
      else await api("/projects/" + project.id + "/messages", { text: value });
      setText("");
      setReplyId(null);
      latest();
    });
  }
  const context = (
    <GoalContext
      project={project}
      tasks={tasks}
      gates={gates}
      active={active}
      openTask={openTask}
    />
  );
  return (
    <div className="goal-layout">
      <section className="conversation">
        <h1 className="sr-only">Goal</h1>
        <div className="page-intro goal-toolbar">
          <div className="repo-line">
            <GitBranch size={13} />
            {project.branch}
            <span>·</span>
            <span>Conversation</span>
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="context-toggle">
                <Layers3 size={14} />
                Context
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="goal-context-popover">
              {context}
            </PopoverContent>
          </Popover>
        </div>
        <ScrollArea
          className="conversation-scroll"
          viewportClassName="messages"
          viewportRef={chat}
          label="Goal conversation"
          fade={0}
          onScroll={() => {
            const element = chat.current!;
            follow.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              64;
            setShowLatest(!follow.current);
          }}
        >
          <div className="conversation-flow" ref={flow}>
            <ConversationMessages
              mode={escalationMode(project)}
              messages={messages}
              gates={historyGates}
              onReply={reply}
              onReview={openReview}
            />
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
                <p>Turn your goal into a plan.</p>
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
          </div>
        </ScrollArea>
        {showLatest ? (
          <Button
            className="latest-message"
            variant="secondary"
            size="sm"
            onClick={latest}
          >
            <ArrowDown size={14} />
            Latest messages
          </Button>
        ) : null}
        <form className="composer" onSubmit={send}>
          {replyGate ? (
            <div className="composer-reply">
              <CornerDownRight size={14} />
              <span>
                {replyGate.status === "open" ? "Reply to" : "Already answered"}{" "}
                · {replyGate.title}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Cancel escalation reply"
                onClick={() => setReplyId(null)}
              >
                <X size={14} />
              </Button>
            </div>
          ) : null}

          <Textarea
            id="message"
            label="Message your agents"
            ref={input}
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
            <span aria-label="Command Enter to send">⌘ ↵</span>
            <Button
              type="submit"
              disabled={
                busy ||
                !text.trim() ||
                (!!replyGate && replyGate.status !== "open")
              }
              size="sm"
            >
              {replyGate ? "Reply & retry" : "Send"}
              <ArrowRight size={14} />
            </Button>
          </div>
        </form>
      </section>
      <div className="goal-context-rail">{context}</div>
    </div>
  );
}

function GoalContext({ project, tasks, gates, active, openTask }: any) {
  return (
    <aside className="goal-context">
      <h2>In motion</h2>
      {active.length ? (
        active.map((run: any) => (
          <div className="context-agent" key={run.id}>
            <Orb active identity={run.role} />
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
          <Button
            variant="ghost"
            className="context-task"
            onClick={() => openTask(task)}
            key={task.id}
          >
            <StatusMark
              status={glyph(task.status)}
              size={17}
              label=""
              color="var(--lr-signal)"
              doneColor="var(--lr-verified)"
            />
            <div>
              <strong>{task.title}</strong>
              <span>{frontierLabel(frontierState(task, tasks))}</span>
            </div>
          </Button>
        ))
      ) : (
        <p className="muted">No tasks yet.</p>
      )}
      <div className="context-authority">
        <Square size={13} />
        <p>Approval before every merge</p>
      </div>
    </aside>
  );
}

function ReviewInbox({ gates, tasks, act, busy }: any) {
  const [selected, setSelected] = useState<string>(""),
    [answer, setAnswer] = useState(""),
    [pr, setPr] = useState<any>(null),
    [diff, setDiff] = useState(""),
    [loadError, setLoadError] = useState(""),
    [confirm, setConfirm] = useState<{ gateId: string; sha: string } | null>(
      null,
    ),
    [loading, setLoading] = useState(false);
  const gate = gates.find((gate: any) => gate.id === selected) ?? gates[0];
  const task = tasks.find((task: any) => task.id === gate?.taskId);
  const mergeOpener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setPr(null);
    setDiff("");
    setAnswer("");
    setLoadError("");
    setLoading(false);
    setConfirm(null);
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
        <h1 className="sr-only">Review</h1>
        <EmptyState
          className="review-clear"
          title="No decisions waiting"
          description="Approval before every merge"
          icon={<ShieldCheck size={40} />}
        />
      </section>
    );
  const response = (
    <div className="decision-response">
      <Textarea
        id="gate-answer"
        label={gate.type === "pr" ? "Request changes" : "Your decision"}
        rows={3}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder={
          gate.type === "pr"
            ? "Describe what should change before merging…"
            : "How should the agents proceed?"
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
  );
  return (
    <section className="page review-page">
      <h1 className="sr-only">Review</h1>
      <div className="workspace-caption">
        <span className="mono">
          {gates.length} {gates.length === 1 ? "decision" : "decisions"} waiting
        </span>
        <span className="approval-note">
          <Square size={12} />
          Human approval required
        </span>
      </div>
      <div className="review-layout">
        <div className="review-queue">
          <div className="review-queue-label">
            Decision inbox <span>{gates.length}</span>
          </div>
          {gates.map((item: any) => (
            <Button
              variant="ghost"
              key={item.id}
              className={item.id === gate.id ? "active" : ""}
              aria-pressed={item.id === gate.id}
              onClick={() => setSelected(item.id)}
            >
              <span className="gate-square" />
              <div>
                <small className="gate-kind">
                  {item.type === "pr"
                    ? "Pull request"
                    : item.type.replaceAll("_", " ")}
                </small>
                <strong>{item.title}</strong>
                <span>
                  {tasks.find((task: any) => task.id === item.taskId)?.title ??
                    "Project direction"}
                </span>
              </div>
            </Button>
          ))}
        </div>
        <article className="review-document">
          <div className="repo-line">
            {gate.type === "pr" ? "Pull request" : "Decision"}
            <span>·</span>
            <DateLabel date={gate.createdAt} />
          </div>

          <h2>{gate.title}</h2>
          {task ? (
            <p className="dossier-task">
              <Layers3 size={14} />
              {task.title}
            </p>
          ) : null}
          <div
            className="decision-brief"
            tabIndex={0}
            aria-label="Decision context"
          >
            <p className="review-summary">{gate.detail}</p>
          </div>
          {gate.judgeStatus ? (
            <div className="judge-assessment">
              <strong>
                {gate.judgeSubmittedAt ? "Judge reply" : "Judge draft"}
              </strong>
              {["pending", "running"].includes(gate.judgeStatus) ? (
                <p role="status" aria-live="polite">
                  <JudgePending
                    text={
                      gate.judgeRecoveryStatus === "running"
                        ? "Resolving this escalation…"
                        : "Reviewing this escalation…"
                    }
                  />
                </p>
              ) : (
                <p>{gate.judgeAnswer ?? gate.judgeError}</p>
              )}
              {gate.judgeAnswer &&
              !gate.judgeSubmittedAt &&
              gate.type !== "pr" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setAnswer(gate.judgeAnswer)}
                >
                  Use judge draft
                </Button>
              ) : null}
              {gate.judgeSources?.length ? (
                <p className="muted">{gate.judgeSources.join(" · ")}</p>
              ) : null}
              {gate.judgeStatus !== "running" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    act(() => api("/gates/" + gate.id + "/judge", {}))
                  }
                >
                  Ask judge again
                </Button>
              ) : null}
            </div>
          ) : null}
          {gate.type !== "pr" ? response : null}
          {gate.type !== "pr" && task ? (
            <Tabs
              key={gate.id}
              defaultValue="contract"
              className="decision-evidence"
            >
              <TabsList variant="line">
                <TabsTrigger value="contract">Task contract</TabsTrigger>
                <TabsTrigger value="checks">Recorded checks</TabsTrigger>
              </TabsList>
              <TabsContent value="contract">
                <p>{task.description}</p>
                {task.acceptance?.length ? (
                  <ul>
                    {task.acceptance.map((criterion: string, index: number) => (
                      <li key={index}>{criterion}</li>
                    ))}
                  </ul>
                ) : null}
              </TabsContent>
              <TabsContent value="checks">
                {task.checks?.length ? (
                  <ul className="check-list">
                    {task.checks.map((check: any, index: number) => (
                      <li key={index}>
                        <StatusMark
                          status={check.code === 0 ? "done" : "failed"}
                          label=""
                          size={16}
                        />
                        <span className="mono">{check.command}</span>
                        <span>Exit {check.code}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No recorded checks.</p>
                )}
              </TabsContent>
            </Tabs>
          ) : null}
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
              {loadError ? <Alert tone="danger" title={loadError} /> : null}
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
                    <Alert tone="warning" title="Revision changed">
                      Request changes so agents can verify and publish the new
                      commit.
                    </Alert>
                  ) : null}
                  <h3>Verification</h3>
                  <ul className="check-list">
                    {task?.checks?.map((check: any, i: number) => (
                      <li key={i}>
                        <StatusMark
                          status={check.code === 0 ? "done" : "failed"}
                          size={15}
                          label=""
                        />
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
                  <Tabs defaultValue="files" className="review-diff-tabs">
                    <TabsList>
                      <TabsTrigger value="files">Change summary</TabsTrigger>
                      <TabsTrigger value="diff">Full diff</TabsTrigger>
                    </TabsList>
                    <TabsContent value="files">
                      <p className="muted">
                        {pr.files?.length ?? 0} files · +
                        {pr.files?.reduce(
                          (sum: number, file: any) => sum + file.additions,
                          0,
                        ) ?? 0}{" "}
                        / −
                        {pr.files?.reduce(
                          (sum: number, file: any) => sum + file.deletions,
                          0,
                        ) ?? 0}
                      </p>
                    </TabsContent>
                    <TabsContent value="diff">
                      <pre className="diff">{diff || "No diff returned."}</pre>
                    </TabsContent>
                  </Tabs>
                  <Button
                    className="merge-button"
                    disabled={
                      busy ||
                      pr.headRefOid !== gate.sha ||
                      pr.state !== "OPEN" ||
                      pr.mergeable !== "MERGEABLE"
                    }
                    onClick={() => {
                      mergeOpener.current =
                        document.activeElement as HTMLElement;
                      setConfirm({ gateId: gate.id, sha: pr.headRefOid });
                    }}
                  >
                    <GitPullRequest size={15} />
                    Approve & merge
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
          {gate.type === "pr" ? response : null}
        </article>
      </div>
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <DialogContent
          title="Merge this revision?"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            mergeOpener.current?.focus();
          }}
          description="This merges the reviewed pull request on GitHub. Looproom will check the commit again before submitting the merge."
        >
          <p className="mono confirm-sha">{confirm?.sha}</p>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Keep reviewing
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                act(async () => {
                  if (!confirm) return;
                  await api("/gates/" + confirm.gateId + "/approve", {
                    sha: confirm.sha,
                  });
                  setConfirm(null);
                })
              }
            >
              Approve & merge
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Settings({ data, project, act, busy, refresh }: any) {
  const [settings, setSettings] = useState({
      ...data.settings,
      judge: data.settings.judge ?? data.settings.subagent,
    }),
    [mode, setMode] = useState<EscalationMode>(escalationMode(project)),
    [checks, setChecks] = useState(project.checks.join("\n")),
    [constraints, setConstraints] = useState(project.constraints),
    [authUrl, setAuthUrl] = useState("");
  useEffect(() => {
    setChecks(project.checks.join("\n"));
    setConstraints(project.constraints);
    setMode(escalationMode(project));
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
          displayName: settings.orchestrator.model
            .replace(/^gpt-/, "GPT-")
            .replace(/-sol$/, " Sol"),
        },
        {
          model: settings.subagent.model,
          displayName: settings.subagent.model
            .replace(/^gpt-/, "GPT-")
            .replace(/-sol$/, " Sol"),
        },
        {
          model: settings.judge.model,
          displayName: settings.judge.model
            .replace(/^gpt-/, "GPT-")
            .replace(/-sol$/, " Sol"),
        },
      ].map((model: any) => [model.model, model]),
    ).values(),
  ] as any[];
  return (
    <section className="page settings-page">
      <h1 className="sr-only">Settings</h1>
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
        <div className="model-roster">
          {(
            [
              {
                role: "orchestrator",
                title: "Orchestrator",
                detail: "Plans the next move",
                Icon: GitBranch,
              },
              {
                role: "subagent",
                title: "Builders & researchers",
                detail: "Turns the plan into working code",
                Icon: Layers3,
              },
              {
                role: "judge",
                title: "Escalation judge",
                detail: "Finds a way forward",
                Icon: ShieldCheck,
              },
            ] as const
          ).map(({ role, title, detail, Icon }) => (
            <div className={"model-role model-role-" + role} key={role}>
              <div className="model-role-label">
                <span className="model-role-icon">
                  <Icon size={19} aria-hidden="true" />
                </span>
                <div>
                  <strong>{title}</strong>
                  <span>{detail}</span>
                </div>
              </div>
              <div className="model-setting">
                <Select
                  value={settings[role].model}
                  onValueChange={(model) =>
                    setSettings({
                      ...settings,
                      [role]: { ...settings[role], model },
                    })
                  }
                  label={title + " model"}
                  id={role + "-model"}
                  options={models.map((model) => ({
                    value: model.model,
                    label: model.displayName,
                  }))}
                />
                <Select
                  value={settings[role].effort}
                  onValueChange={(effort) =>
                    setSettings({
                      ...settings,
                      [role]: { ...settings[role], effort },
                    })
                  }
                  label={title + " reasoning"}
                  id={role + "-effort"}
                  options={["low", "medium", "high", "xhigh", "max"].map(
                    (effort) => ({
                      value: effort,
                      label: effort[0].toUpperCase() + effort.slice(1),
                    }),
                  )}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="workflow-setting">
          <div className="workflow-label">
            <Layers3 size={19} aria-hidden="true" />
            <div>
              <strong>Concurrent workflows</strong>
              <span>Active at once, across your agents</span>
            </div>
          </div>
          <div className="workflow-counter">
            <NumberField
              id="concurrency"
              label="Concurrent workflows"
              min={1}
              max={4}
              step={1}
              largeStep={1}
              scrub={false}
              value={settings.concurrency}
              onValueChange={(concurrency) =>
                setSettings({ ...settings, concurrency })
              }
            />
          </div>
        </div>
        <ActionButton
          disabled={busy}
          onAction={() =>
            act(
              () =>
                api("/settings", {
                  orchestrator: settings.orchestrator,
                  subagent: settings.subagent,
                  judge: settings.judge,
                  concurrency: settings.concurrency,
                }),
              true,
            )
          }
          label="Save model settings"
          pendingLabel="Saving…"
          successLabel="Saved"
        />
      </section>
      <NotificationSettings />
      <section className="setting-section">
        <h2>Project boundaries</h2>
        <div className="bypass-setting">
          <div>
            <strong>Escalations</strong>
            <p>
              {mode === "yolo"
                ? "Judge handles replies and recovery. You approve PR merges."
                : mode === "bypass"
                  ? "Judge sends routine decisions. Blockers wait for you."
                  : "Judge prepares a draft. You choose the response."}
            </p>
          </div>
          <Select
            id="escalation-mode"
            label="Escalation mode"
            value={mode}
            onValueChange={(value) => setMode(value as EscalationMode)}
            options={[
              { value: "human", label: "Human review" },
              { value: "bypass", label: "Judge bypass" },
              { value: "yolo", label: "YOLO" },
            ]}
          />
        </div>

        <Textarea
          id="settings-constraints"
          label="Scope and exclusions"
          rows={3}
          value={constraints}
          onChange={(event) => setConstraints(event.target.value)}
        />

        <Textarea
          id="settings-checks"
          label="Authorized checks · one command per line"
          rows={3}
          value={checks}
          onChange={(event) => setChecks(event.target.value)}
        />
        <p className="field-help">
          Commands run through the Codex workspace sandbox with direct network
          disabled. Package installation may need a human step.
        </p>
        <ActionButton
          disabled={busy}
          onAction={() =>
            act(
              () =>
                api("/projects/" + project.id + "/settings", {
                  checks: checks
                    .split("\n")
                    .map((line: string) => line.trim())
                    .filter(Boolean),
                  constraints,
                  escalationMode: mode,
                }),
              true,
            )
          }
          label="Save project settings"
          pendingLabel="Saving…"
          successLabel="Saved"
        />
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

function TaskDetail({
  task,
  tasks,
  onClose,
  restoreFocus,
}: {
  task: any;
  tasks: any[];
  onClose: () => void;
  restoreFocus: () => void;
}) {
  return (
    <Dialog
      open={!!task}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="task-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        title={task?.title ?? "Task"}
        description={
          task
            ? frontierLabel(frontierState(task, tasks)) + " · " + task.kind
            : undefined
        }
      >
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
            {task.checks?.length ? (
              <Accordion
                defaultOpen={-1}
                items={task.checks.map((check: any) => ({
                  title:
                    (check.code === 0 ? "Passed: " : "Failed: ") +
                    check.command +
                    " · exit " +
                    check.code,
                  content: <pre>{check.output}</pre>,
                }))}
              />
            ) : null}
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
