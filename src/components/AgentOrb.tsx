import { useState } from "react";
import { Shdr11 } from "./ui/shdr-11";
import { Shdr13 } from "./ui/shdr-13";
import { Shdr12 } from "./ui/shdr-12";
import { Shdr16 } from "./ui/shdr-16";
import { Shdr23 } from "./ui/shdr-23";
const identities = {
  orchestrator: Shdr11,
  implementation: Shdr12,
  review: Shdr23,
  research: Shdr16,
  judge: Shdr13,
};
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
  const Shader = identities[identity as keyof typeof identities] ?? Shdr11;
  return (
    <span
      className={`agent-orb orb-${identity}`}
      aria-hidden="true"
      data-orb={identity}
    >
      {unavailable ? (
        <span className="orb-fallback" style={{ width: size, height: size }}>
          {identity.slice(0, 1).toUpperCase()}
        </span>
      ) : (
        <Shader
          size={size}
          state={active ? "thinking" : "idle"}
          maxDpr={1.5}
          onUnavailable={() => setUnavailable(true)}
        />
      )}
    </span>
  );
}
