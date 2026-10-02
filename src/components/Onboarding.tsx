import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ExternalLink, ShieldCheck, Square } from "lucide-react";
import { Alert } from "./arc/alert/alert";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { DotmSquare3 } from "./ui/dotm-square-3";
import Stepper, { Step } from "./ui/Stepper";
import FolderPicker from "./FolderPicker";
import { api, type Data } from "../lib/api";

function Pending({ label }: { label: string }) {
  return <span className="pending" role="status"><DotmSquare3 size={18} dotSize={3} color="var(--lr-signal)" /><span>{label}</span></span>;
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
export default function Onboarding({
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
  const inspectVersion = useRef(0);
  useEffect(
    () => localStorage.setItem("looproom.onboarding.v1", JSON.stringify(draft)),
    [draft],
  );
  const update = (key: string, value: string | boolean) => {
    setDraft((draft: any) => ({ ...draft, [key]: value }));
    if (["path", "mode"].includes(key)) {
      ++inspectVersion.current;
      setRepo(null);
    }
  };
  async function inspect() {
    const version = ++inspectVersion.current;
    setPending(true);
    setError("");
    try {
      const result = await api("/repos/inspect", {
        path: draft.path,
        mode: draft.mode,
      });
      if (version === inspectVersion.current) {
        setRepo(result);
        if (!draft.name) update("name", result.path.split("/").pop());
      }
    } catch (error) {
      if (version === inspectVersion.current)
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
                    aria-label="Set up my account later"
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

