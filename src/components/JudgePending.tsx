import "./judge-pending.css";

// CSS variant adapted from ReactBits Shiny Text (MIT + Commons Clause); source recorded in the wiki.
export default function JudgePending({
  text = "Reviewing this escalation…",
}: {
  text?: string;
}) {
  return <span className="judge-shine">{text}</span>;
}
