import { nativeTestBroker } from "./verification-broker.ts";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  lstat,
  readlink,
  writeFile,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { exec } from "./git.ts";

const omitted = (name: string) =>
  [
    ".git",
    ".codex",
    ".env",
    ".npmrc",
    ".netrc",
    "auth.json",
    ".ssh",
    ".aws",
    ".gnupg",
    "dist",
    ".looproom-test-fixtures",
    ".looproom-verification",
    "node_modules",
  ].includes(name) ||
  name.startsWith(".env.") ||
  /\.(pem|key)$/i.test(name);
export async function sourceFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(dir: string) {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (omitted(item.name)) continue;
      const path = join(dir, item.name),
        key = relative(root, path),
        meta = await lstat(path);
      hash.update(
        JSON.stringify([
          key,
          meta.mode & 0o777,
          item.isSymbolicLink() ? "link" : item.isDirectory() ? "dir" : "file",
        ]),
      );
      if (item.isSymbolicLink()) hash.update(await readlink(path));
      else if (item.isDirectory()) await walk(path);
      else if (item.isFile()) hash.update(await readFile(path));
    }
  }
  await walk(root);
  return hash.digest("hex");
}
const quote = (value: string) => JSON.stringify(value);
export function npmReadRoot(executable: string) {
  const root = dirname(dirname(executable));
  return basename(executable) === "npm-cli.js" && basename(dirname(executable)) === "bin" && basename(root) === "npm"
    ? root : executable;
}
export function verificationPolicy(
  job: string,
  readRoots: string[],
  protectedPorts: number[],
  nativeSocket = join(job, "native-check.sock"),
) {
  const denied = protectedPorts.flatMap((port) => [
    `(remote tcp "localhost:${port}")`,
  ]);
  return `(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow process-info* (target same-sandbox))
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow file-read* (literal "/") (literal "/private/etc/passwd") (literal "/private/etc/localtime") (subpath "/private/var/db/timezone"))
(allow file-read* file-write-data (subpath "/dev/fd"))
(allow file-read-metadata)
(allow file-read* file-map-executable ${readRoots.map((root) => `(subpath ${quote(root)})`).join(" ")})
(allow file-read* file-write* file-map-executable (subpath ${quote(job)}))
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/tty"))
(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))
(allow file-ioctl (literal "/dev/null") (literal "/dev/tty"))
(allow network-outbound (literal ${quote(nativeSocket)}))
(allow network-bind (local tcp "localhost:*"))
(allow network-inbound (local tcp "localhost:*"))
(allow network-outbound (remote tcp "localhost:*"))
${denied.length ? `(deny network-outbound ${denied.join(" ")})` : ""}
(deny file-read* (regex #"(^|/)([.]env([.][^/]*)?|auth[.]json|[.]npmrc|[.]netrc)$") (regex #"[.](pem|key)$"))
(deny file-write* (subpath ${quote(join(job, "workspace/.git"))}))
(deny file-write* (literal ${quote(join(job, "policy.sb"))}))
`;
}
export type VerificationResult = {
  command: string;
  code: number;
  output: string;
  timedOut: boolean;
  durationMs: number;
};
export type VerificationReport = {
  id: string;
  sourceHash: string;
  sourceUnchanged: boolean;
  results: VerificationResult[];
  reportPath: string;
  createdAt: string;
  fixtureCleanup?: { path: string; removed: boolean };
};
// Coordinator housekeeping for the reserved, ignored test scratch directory.
// Never follow its root or nested symlinks into project/source directories.
export async function cleanupTestFixtures(cwd: string) {
  const root = await realpath(cwd), path = join(root, ".looproom-test-fixtures");
  const meta = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!meta) return { path, removed: false };
  if (!meta.isDirectory() || meta.isSymbolicLink() || await realpath(path) !== path)
    throw new Error("Test fixture cleanup requires a real reserved scratch directory.");
  await rm(path, { recursive: true });
  return { path, removed: true };
}
export async function runVerification(options: {
  cwd: string;
  commands: string[];
  dataDir: string;
  codexBinary: string;
  protectedPorts?: number[];
  timeoutMs?: number;
  cleanupFixtures?: boolean;
}): Promise<VerificationReport> {
  if (process.platform !== "darwin")
    throw new Error("Isolated verification currently requires macOS.");
  if (
    !options.commands.length ||
    options.commands.length > 8 ||
    options.commands.some((c) => !c.trim() || c.length > 500)
  )
    throw new Error("Choose 1–8 configured verification commands.");
  const cwd = await realpath(options.cwd),
    id = randomUUID();
  const sourceHash = await sourceFingerprint(cwd);
  const base = resolve(options.dataDir, "verification"),
    job = join(base, id),
    workspace = join(job, "workspace");
  await mkdir(base, { recursive: true, mode: 0o700 });
  await mkdir(job, { mode: 0o700 });
  const canonicalJob = await realpath(job);
  const reportPath = join(base, id + ".json");
  let broker: Awaited<ReturnType<typeof nativeTestBroker>> | undefined;
  try {
    const fixtureCleanup = options.cleanupFixtures ? await cleanupTestFixtures(cwd) : undefined;
    await cp(cwd, workspace, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (path) => {
        const rel = relative(cwd, path);
        const parts = rel.split("/");
        if (parts[0] === "node_modules")
          return !parts.some(
            (name) =>
              [".git", ".codex", ".env", ".npmrc", ".netrc", "auth.json", ".ssh", ".aws", ".gnupg"].includes(name) ||
              name.startsWith(".env.") ||
              /\.(pem|key)$/i.test(name),
          );
        return !rel || !parts.some((name) => omitted(name));
      },
    });
    // Never mount or follow a dependency tree outside the assigned worktree.
    const modules = join(cwd, "node_modules");
    const moduleMeta = await lstat(modules).catch(() => null);
    if (moduleMeta?.isSymbolicLink())
      throw new Error(
        "Verification requires a worktree-local dependency tree.",
      );
    async function normalizeLinks(dir: string) {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory()) await normalizeLinks(path);
        else if (item.isSymbolicLink()) {
          const link = await readlink(path),
            target = resolve(dirname(path), link);
          if (target.startsWith(workspace + "/")) continue;
          const marker = "/node_modules/",
            index = target.lastIndexOf(marker);
          const replacement =
            index >= 0
              ? resolve(
                  workspace,
                  "node_modules",
                  target.slice(index + marker.length),
                )
              : "";
          if (
            !replacement.startsWith(join(workspace, "node_modules") + "/") ||
            !(await lstat(replacement).catch(() => null))
          )
            throw new Error(
              "Dependency symlink escapes verification snapshot: " +
                relative(workspace, path),
            );
          await rm(path);
          await symlink(relative(dirname(path), replacement), path);
        }
      }
    }
    if (moduleMeta) await normalizeLinks(join(workspace, "node_modules"));
    const copiedHash = await sourceFingerprint(workspace);
    if (
      sourceHash !== copiedHash ||
      sourceHash !== (await sourceFingerprint(cwd))
    )
      throw new Error(
        "Task source changed while preparing verification; retry with a stable snapshot.",
      );
    // Snapshot-only Git metadata supports checks without access to the real repository.
    const snapshotGit = (args: string[]) => exec("/usr/bin/git", ["-C", workspace,
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      env: { PATH: "/usr/bin:/bin", HOME: canonicalJob,
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    await snapshotGit(["init", "-b", "verification"]);
    await snapshotGit(["add", "."]);
    await snapshotGit([
      "-c",
      "user.name=Looproom verification",
      "-c",
      "user.email=verification@localhost",
      "commit",
      "--allow-empty",
      "-m",
      "Disposable verification snapshot",
    ]);
    const home = join(canonicalJob, "home"),
      tmp = join(canonicalJob, "tmp");
    await mkdir(home);
    await mkdir(tmp);
    const node = await realpath(process.execPath);
    const npm = (await exec("/usr/bin/which", ["npm"])).stdout.trim();
    const npmRoot = npmReadRoot(await realpath(npm));
    const binary = await realpath(
      options.codexBinary.includes("/")
        ? options.codexBinary
        : (await exec("/usr/bin/which", [options.codexBinary])).stdout.trim(),
    );
    const developer = (
      await exec("/usr/bin/xcode-select", ["-p"]).catch(() => ({ stdout: "" }))
    ).stdout.trim();
    const readRoots = [
      "/System",
      "/usr",
      "/bin",
      "/sbin",
      dirname(node),
      npmRoot,
      dirname(binary),
      ...(developer ? [await realpath(developer)] : []),
    ];
    broker = await nativeTestBroker(canonicalJob, binary);
    const policy = verificationPolicy(
      canonicalJob,
      readRoots,
      options.protectedPorts ?? [4319, 5173],
      broker.socket,
    );
    const profilePath = join(job, "policy.sb");
    await writeFile(profilePath, policy);
    const env = {
      PATH: [
        broker.bin,
        dirname(node),
        dirname(npm),
        dirname(binary),
        ...(developer ? [join(developer, "usr/bin")] : []),
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
      HOME: home,
      TMPDIR: tmp + "/",
      CODEX_HOME: join(home, "codex"),
      CODEX_BINARY: join(broker.bin, "codex"),
      LOOPROOM_VERIFICATION_JOB: "1",
      OPENSSL_CONF: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      TSX_DISABLE_CACHE: "1",
      CI: "1",
      npm_config_cache: join(home, "npm-cache"),
      npm_config_userconfig: "/dev/null",
    };
    const results: VerificationResult[] = [];
    for (const command of options.commands) {
      results.push(
        await new Promise<VerificationResult>((resolve, reject) => {
          const start = Date.now();
          let output = "",
            timedOut = false;
          const child = spawn(
            "/usr/bin/sandbox-exec",
            ["-f", profilePath, "/bin/zsh", "-f", "-c", command],
            {
              cwd: workspace,
              env,
              stdio: ["ignore", "pipe", "pipe"],
              detached: true,
            },
          );
          const kill = (signal: NodeJS.Signals) => {
            if (child.pid)
              try {
                process.kill(-child.pid, signal);
              } catch {}
          };
          let hard: ReturnType<typeof setTimeout> | undefined;
          const timer = setTimeout(() => {
            timedOut = true;
            kill("SIGTERM");
            hard = setTimeout(() => kill("SIGKILL"), 1000);
          }, options.timeoutMs ?? 180_000);
          const read = (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-100_000);
          };
          child.stdout.on("data", read);
          child.stderr.on("data", read);
          child.once("error", (error) => {
            clearTimeout(timer);
            clearTimeout(hard);
            reject(error);
          });
          child.once("close", (code) => {
            clearTimeout(timer);
            clearTimeout(hard);
            kill("SIGKILL");
            resolve({
              command,
              code: timedOut ? 124 : (code ?? 1),
              output,
              timedOut,
              durationMs: Date.now() - start,
            });
          });
        }),
      );
    }
    const sourceUnchanged = sourceHash === (await sourceFingerprint(cwd));
    const report = {
      id,
      sourceHash,
      sourceUnchanged,
      results,
      reportPath,
      createdAt: new Date().toISOString(),
      ...(fixtureCleanup ? { fixtureCleanup } : {}),
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    return report;
  } finally {
    await broker?.close();
    await rm(job, { recursive: true, force: true });
  }
}
