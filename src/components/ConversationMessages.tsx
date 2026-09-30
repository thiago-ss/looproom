import { lazy, Suspense } from "react";
import { ArrowRight, CornerDownRight, ShieldCheck, Square } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
const Orb = lazy(() => import("./AgentOrb"));
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
}: {
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
          response = message.kind === "escalation_response",
          open = gate?.status === "open";
        return (
          <article
            key={message.id}
            className={`message ${message.role} ${escalation ? "escalation" : ""} ${response ? "escalation-response" : ""}`}
          >
            <div className="message-byline">
              {message.role === "judge" ? (
                <Suspense fallback={<ShieldCheck size={20} />}>
                  <Orb active={false} size={26} identity="judge" />
                </Suspense>
              ) : message.role !== "human" ? (
                <img src="/brand/looproom-mark.svg?v=3" alt="" />
              ) : null}
              <strong>{names[message.role] ?? message.role}</strong>
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
                  <span>Escalation reply · {gate?.title ?? "Decision"}</span>
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
                    {open ? (
                      <>
                        {gate.type !== "pr" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onReply(gate)}
                          >
                            Reply
                          </Button>
                        ) : null}
                        <Button size="sm" variant="ghost" onClick={onReview}>
                          Review <ArrowRight size={14} />
                        </Button>
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
                message.text
              )}
            </div>
          </article>
        );
      })}
    </>
  );
}
