import { ArrowRight, CornerDownRight, ShieldCheck, Square } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { submittedWait } from "../lib/work";
const names: Record<string, string> = {
  human: "You",
  orchestrator: "Orchestrator",
  implementation: "Builder",
  research: "Researcher",
  review: "Reviewer",
  judge: "Judge",
  coordinator: "Coordinator",
};
export default function ConversationMessages({
  messages,
  gates,
  onReply,
  onReview,
  mode,
}: {
  mode?: string;
  messages: any[];
  gates: any[];
  onReply: (gate: any) => void;
  onReview: () => void;
}) {
  const gateById = new Map(gates.map((gate) => [gate.id, gate]));
  const recordedRequests = new Set(
    messages
      .filter((message) => message.kind === "escalation")
      .map((message) => message.gateId),
  );
  // Older coordinators may have gates without chat records until the durable migration runs.
  const requests = gates
    .filter((gate) => !recordedRequests.has(gate.id))
    .map((gate) => ({
      id: "escalation:" + gate.id,
      gateId: gate.id,
      kind: "escalation",
      role: gate.authorRole ?? "coordinator",
      title: gate.title,
      text: gate.detail,
      createdAt: gate.createdAt,
    }));
  const entries = [...messages, ...requests].sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      Number(b.kind === "escalation") - Number(a.kind === "escalation"),
  );
  return (
    <>
      {entries.map((message) => {
        const gate = gateById.get(message.gateId),
          escalation = message.kind === "escalation",
          response = ["escalation_response", "escalation_draft"].includes(
            message.kind,
          ),
          draft = message.kind === "escalation_draft",
          open = gate?.status === "open",
          waiting = submittedWait(message, gate);
        return (
          <article
            key={message.id}
            className={`message ${message.role} ${escalation ? "escalation" : ""} ${response ? "escalation-response" : ""}`}
          >
            <div className="message-byline">
              {message.role === "judge" ? (
                // History can contain hundreds of replies; reserve WebGL for live activity.
                <img
                  src="/orbs/judge-idle.png"
                  className="agent-orb orb-judge"
                  data-orb="judge"
                  width={26}
                  height={26}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              ) : message.role !== "human" ? (
                <img src="/brand/looproom-mark.svg?v=3" alt="" />
              ) : null}
              <strong>{names[message.role] ?? message.role}</strong>
              {waiting ? (
                <Badge variant="secondary">Still blocked</Badge>
              ) : null}
              {escalation ? (
                <Badge variant="secondary">Escalation</Badge>
              ) : null}
              <time dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
            <div className="message-body">
              {response ? (
                <div className="reply-context">
                  <CornerDownRight size={14} />
                  <span>
                    {draft
                      ? "Draft for escalation"
                      : waiting
                        ? "Judge replied · waiting for access"
                        : "Escalation reply"}{" "}
                    · {gate?.title ?? "Decision"}
                  </span>
                </div>
              ) : null}
              {escalation ? (
                <>
                  <div className="escalation-title">
                    <Square size={14} />
                    <strong>{message.title}</strong>
                  </div>
                  <p>{message.text}</p>
                  <div className="escalation-actions">
                    {gate?.awaitingCapability ? (
                      <Badge variant="secondary">Judge replied · blocked</Badge>
                    ) : null}
                    {open ? (
                      <>
                        {gate.type !== "pr" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onReply(gate)}
                          >
                            {mode === "yolo" ? "Add context" : "Reply"}
                          </Button>
                        ) : null}
                        {mode !== "yolo" || gate.type === "pr" ? (
                          <Button size="sm" variant="ghost" onClick={onReview}>
                            Review <ArrowRight size={14} />
                          </Button>
                        ) : null}
                        {gate.judgeStatus === "failed" ? (
                          <Badge variant="secondary">Judge unavailable</Badge>
                        ) : null}
                        {gate.judgeStatus === "running" ? (
                          <Badge variant="secondary">Judge thinking</Badge>
                        ) : null}
                      </>
                    ) : (
                      <span className="escalation-resolved">
                        <ShieldCheck size={14} />
                        {gate?.status === "approved"
                          ? "Merged with your approval"
                          : `Answered by ${gate?.resolvedBy === "judge" ? "Judge" : "you"}`}
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {message.text}
                  {waiting && gate.judgeNextAttemptAt ? (
                    <div className="reply-context">
                      Next check{" "}
                      {new Date(gate.judgeNextAttemptAt).toLocaleTimeString(
                        [],
                        { hour: "2-digit", minute: "2-digit" },
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </article>
        );
      })}
    </>
  );
}
