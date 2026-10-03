import "./status-mark.css";
import type { CSSProperties, ReactNode } from "react";

export type StatusMarkStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export interface StatusMarkProps {
  status?: StatusMarkStatus;
  progress?: number;
  label?: ReactNode;
  color?: string;
  doneColor?: string;
  errorColor?: string;
  size?: number;
  strokeWidth?: number;
  dashes?: number;
  fontSize?: number;
  spinDuration?: number;
  arcLength?: number;
  drawDuration?: number;
  fillOpacity?: number;
  strike?: boolean;
  strikeDelay?: number;
  className?: string;
  style?: CSSProperties;
}

const descriptions: Record<StatusMarkStatus, string> = {
  pending: "Pending", running: "In progress", done: "Completed", failed: "Failed", cancelled: "Cancelled",
};

export default function StatusMark({
  status = "pending", progress, label, color = "currentColor", doneColor = "#22c55e",
  errorColor = "#ef4444", size = 20, strokeWidth = 2, dashes = 8,
  fontSize = 14, spinDuration = 1100, arcLength = 0.68, drawDuration = 240,
  fillOpacity = 0.06, strike = true, strikeDelay = 60, className = "", style,
}: StatusMarkProps) {
  const boundedProgress = typeof progress === "number" && Number.isFinite(progress)
    ? Math.max(0, Math.min(1, progress)) : undefined;
  const running = status === "running";
  const spinning = running && boundedProgress === undefined;
  const radius = Math.max(0.5, 10 - strokeWidth / 2);
  const circumference = 2 * Math.PI * radius;
  const amount = running ? (boundedProgress ?? arcLength) : status === "pending" || status === "cancelled" ? 0 : 1;
  const stroke = status === "done" ? doneColor : status === "failed" ? errorColor : color;
  const description = `${descriptions[status]}${running && boundedProgress !== undefined ? `, ${Math.round(boundedProgress * 100)}%` : ""}`;
  const dotLength = circumference / Math.max(1, dashes);
  const ringDash = status === "pending" || status === "cancelled"
    ? `${dotLength * 0.34} ${dotLength * 0.66}`
    : `${circumference * amount} ${circumference}`;

  return <span className={`status-mark ${className}`} data-status={status} style={{
    "--status-size": `${size}px`, "--status-font": `${fontSize}px`,
    "--status-spin": `${spinDuration}ms`, "--status-draw": `${drawDuration}ms`,
    "--status-strike-delay": `${strikeDelay}ms`, ...style,
  } as CSSProperties}>
    <svg width={size} height={size} viewBox="0 0 24 24" role={label == null ? "img" : undefined}
      aria-label={label == null ? description : undefined} aria-hidden={label == null ? undefined : true}>
      <circle cx="12" cy="12" r={radius} fill={status === "done" || status === "failed" ? stroke : "none"} fillOpacity={fillOpacity} />
      <circle className="status-mark-track" cx="12" cy="12" r={radius} fill="none" stroke={stroke} strokeWidth={strokeWidth} opacity={running ? 0.2 : 0} />
      <g className={spinning ? "status-mark-spin" : undefined}>
        <circle cx="12" cy="12" r={radius} fill="none" stroke={stroke} strokeWidth={strokeWidth}
          strokeLinecap="round" strokeDasharray={ringDash} transform="rotate(-90 12 12)" />
      </g>
      {status === "done" && <path d="m7.5 12.25 3 3 6.25-6.5" fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />}
      {(status === "failed" || status === "cancelled") && <path d="m8.5 8.5 7 7m0-7-7 7" fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />}
    </svg>
    {label != null && <span className="status-mark-label" style={{ color }}><span className="sr-only">{description}: </span><span className={status === "done" && strike ? "status-mark-struck" : undefined}>{label}</span></span>}
  </span>;
}
