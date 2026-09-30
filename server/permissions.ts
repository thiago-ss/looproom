import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { git } from "./git.ts";

// Named profiles keep credential reads and direct network outside the worker boundary.
export async function permissionConfig(cwd: string, write: boolean) {
  const filesystem: Record<string, any> = {
    ":root": "deny",
    ":minimal": "read",
    ":tmpdir": "deny",
    ":slash_tmp": "deny",
    [cwd]: {
      ".": write ? "write" : "read",
      ".git": "read",
      ".codex": "read",
      "**/.env": "deny",
      "**/.env.*": "deny",
      "**/*.pem": "deny",
      "**/*.key": "deny",
    },
  };
  const common = await git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).catch(() => "");
  if (common) filesystem[common] = "read";
  // Toolchains installed outside the platform minimum are readable, never writable.
  for (const command of ["node", "npm"]) {
    const { exec } = await import("./git.ts");
    const location = await exec("/usr/bin/which", [command])
      .then((result) => result.stdout.trim())
      .catch(() => "");
    if (location) filesystem[dirname(await realpath(location))] = "read";
  }
  return {
    default_permissions: "looproom",
    permissions: { looproom: { filesystem, network: { enabled: false } } },
    features: { multi_agent: false },
    web_search: "cached",
  };
}

// CLI -c accepts TOML; emit whole tables without interpolating shell command strings.
export function configArgs(config: Record<string, any>): string[] {
  function toml(value: any): string {
    if (value && typeof value === "object" && !Array.isArray(value))
      return (
        "{ " +
        Object.entries(value)
          .map(([key, item]) => JSON.stringify(key) + " = " + toml(item))
          .join(", ") +
        " }"
      );
    if (Array.isArray(value)) return "[" + value.map(toml).join(", ") + "]";
    return JSON.stringify(value);
  }
  return Object.entries(config).flatMap(([key, value]) => [
    "-c",
    key + "=" + toml(value),
  ]);
}
