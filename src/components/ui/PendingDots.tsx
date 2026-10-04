import { useEffect, useState, type CSSProperties } from "react";

export interface DotmSquare3Props {
  size?: number;
  dotSize?: number;
  color?: string;
  colorPreset?: "solid-theme" | "solid-mint" | "grad-sunset" | "grad-ocean" | "grad-neon" | "grad-aurora" | "grad-fire" | "grad-prism";
  speed?: number;
  ariaLabel?: string;
  className?: string;
  pattern?: "diamond" | "full" | "outline" | "rose" | "cross" | "rings";
  muted?: boolean;
  bloom?: boolean;
  halo?: number;
  animated?: boolean;
  hoverAnimated?: boolean;
  dotClassName?: string;
  dotShape?: "circle" | "square" | "diamond" | "hearts";
  opacityBase?: number;
  opacityMid?: number;
  opacityPeak?: number;
  cellPadding?: number;
  boxSize?: number;
  minSize?: number;
}

const cells = Array.from({ length: 25 }, (_, index) => ({ index, row: Math.floor(index / 5), col: index % 5 }));
const path = [0, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5, 6, 7, 8, 13, 18, 17, 16, 11, 12];
const presetFills: Record<NonNullable<DotmSquare3Props["colorPreset"]>, string> = {
  "solid-theme": "var(--lr-signal)", "solid-mint": "#34d399",
  "grad-sunset": "linear-gradient(135deg, #ff5f6d, #ffc371)",
  "grad-ocean": "linear-gradient(135deg, #00c6ff, #0072ff)",
  "grad-neon": "linear-gradient(135deg, #b4ff39, #00d4ff)",
  "grad-aurora": "linear-gradient(135deg, #ff3cac, #2b86c5)",
  "grad-fire": "linear-gradient(135deg, #ff512f, #ffb347)",
  "grad-prism": "linear-gradient(135deg, #12c2e9, #f64f59)",
};

export function PendingDots({
  size = 36, dotSize = 5, color = "currentColor", colorPreset, speed = 1.35,
  ariaLabel = "Loading", className = "", pattern = "full", muted = false,
  bloom = false, halo = 0, animated = true, hoverAnimated = false,
  dotClassName = "", dotShape = "circle", opacityBase = 0.16,
  opacityMid = 0.32, opacityPeak = 1, cellPadding = 0, boxSize,
  minSize,
}: DotmSquare3Props) {
  const [hovered, setHovered] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const activeAnimation = !reducedMotion && (hoverAnimated ? hovered : animated);
  const dotFill = colorPreset ? presetFills[colorPreset] : color;
  const width = Math.max(minSize ?? 0, boxSize ?? size);
  const visible = (row: number, col: number) => {
    const distance = Math.abs(row - 2) + Math.abs(col - 2);
    if (pattern === "diamond") return distance <= 2;
    if (pattern === "outline") return row === 0 || row === 4 || col === 0 || col === 4;
    if (pattern === "cross") return row === 2 || col === 2;
    if (pattern === "rings") return distance !== 1;
    if (pattern === "rose") return distance <= 3;
    return true;
  };
  return <span className={`looproom-dots looproom-dots-${dotShape} ${className}`} role="status" aria-label={ariaLabel}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    style={{ width, height: width, color, "--dots-fill": dotFill, "--dots-duration": `${1500 / Math.max(0.1, speed)}ms`,
      "--dots-rest": muted ? opacityBase * 0.6 : (opacityBase + opacityMid) / 2,
      "--dots-peak": opacityPeak, "--dots-glow": bloom || halo > 0 ? `0 0 ${Math.max(2, halo * 8)}px currentColor` : "none",
    } as CSSProperties}>
    {cells.map(({ index, row, col }) => <span key={index} aria-hidden="true"
      className={`looproom-dot ${dotClassName} ${activeAnimation ? "is-animated" : ""}`}
      style={{ width: dotSize, height: dotSize, margin: cellPadding,
        visibility: visible(row, col) ? "visible" : "hidden",
        animationDelay: `${path.indexOf(index) * 55 / Math.max(0.1, speed)}ms`,
        opacity: activeAnimation ? undefined : opacityBase + (path.indexOf(index) / 24) * (opacityPeak - opacityBase) * 0.75,
      }} />)}
  </span>;
}
