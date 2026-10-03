import "./judge-pending.css";

export default function JudgePending({ text = "Reviewing this escalation…" }: { text?: string }) {
  return <span className="judge-shine" role="status">{text}</span>;
}
