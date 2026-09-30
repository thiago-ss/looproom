import { useState } from "react";
import { Shdr11 } from "./ui/shdr-11";
export default function AgentOrb({
  active,
  size = 54,
  identity = "orchestrator",
}: {
  active: boolean;
  size?: number;
  identity?: string;
}) {
  const [unavailable, setUnavailable] = useState(false);
  const shape =
    { orchestrator: 0.9, implementation: 0.78, review: 1.03, research: 0.85 }[
      identity
    ] ?? 0.9;
  return (
    <span className="agent-orb" aria-hidden="true">
      {unavailable ? (
        <img src="/brand/looproom-mark.svg" width={size} height={size} alt="" />
      ) : (
        <Shdr11
          size={size}
          state={active ? "thinking" : "idle"}
          maxDpr={1.5}
          params={{ chromaSpread: 0.04, glow: 0.6, radius: shape }}
          onUnavailable={() => setUnavailable(true)}
        />
      )}
    </span>
  );
}
