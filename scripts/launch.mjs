import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = resolve(process.env.LOOPROOM_DATA_DIR ?? join(homedir(), "Library", "Application Support", "Looproom"));
const port = Number(process.env.PORT ?? 4319);
const url = `http://127.0.0.1:${port}`;
const stamp = join(root, "dist", ".looproom-build.json");
const installRecord = join(root, "node_modules", ".looproom-install.json");
const ignored = new Set([".git", "node_modules", "dist", ".looproom-verification", ".looproom-test-fixtures"]);
const preparationDb = join(root, ".looproom-launch.sqlite");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function acquirePreparationLock(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let db;
  try {
    db = new DatabaseSync(preparationDb);
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE");
        return db;
      } catch (error) {
        if (error.code !== "ERR_SQLITE_ERROR" || !/database is locked|database is busy/i.test(error.message)) throw error;
        if (Date.now() >= deadline)
          throw new Error("Timed out waiting for another Looproom launch to finish preparing this worktree. Check its terminal, then retry.");
        await pause(200);
      }
    }
  } catch (error) {
    db?.close();
    throw error;
  }
}

function version(output) {
  return output.match(/(?:^|[^\d])(\d+)\.(\d+)(?:\.(\d+))?\b/)?.slice(1).map(Number);
}
function atLeast(actual, minimum) {
  for (let i = 0; i < minimum.length; i++) {
    if ((actual[i] ?? 0) > minimum[i]) return true;
    if ((actual[i] ?? 0) < minimum[i]) return false;
  }
  return true;
}
function requireTool(binary, args, minimum, help) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 5000 });
  const found = version(result.stdout ?? "");
  if (result.error || result.status !== 0 || !found || !atLeast(found, minimum))
    throw new Error(`${help} Found: ${(result.stdout || result.stderr || result.error?.message || "not installed").trim()}`);
}
function requireNode() {
  if (!atLeast(version(process.version) ?? [], [22, 13, 0]))
    throw new Error(`Node.js 22.13 or later is required; found ${process.version}. Install a supported Node.js release and reopen Looproom.`);
}
function prerequisites() {
  requireTool("git", ["--version"], [2, 35, 0], "Git 2.35 or later is required for worktrees. Install or update Git and reopen Looproom.");
  requireTool(process.env.CODEX_BINARY ?? "codex", ["--version"], [0, 159, 2], "Codex CLI 0.159.2 or later is required. Install or update Codex CLI, or set CODEX_BINARY to its path, then reopen Looproom.");
}
async function existingCoordinator(targetPort = port) {
  const expectedDataDir = await realpath(dataDir).catch(() => dataDir);
  const deadline = Date.now() + 15000;
  for (;;) {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${targetPort}/api/health`, { signal: AbortSignal.timeout(1500) });
    } catch (error) {
      if (error.cause?.code === "ECONNREFUSED") return false;
      throw new Error(`Cannot identify the service on port ${targetPort}: ${error.message}. Close it or set PORT to another free port.`);
    }
    const health = await response.json().catch(() => null);
    if (health?.app === "looproom" && health?.root === root && health?.dataDir === expectedDataDir) {
      if (response.ok && health.status === "ok") return true;
      if (response.status === 503 && health.status === "starting") {
        if (Date.now() >= deadline) throw new Error(`Looproom on port ${targetPort} did not finish starting. Check its terminal for errors.`);
        await new Promise((done) => setTimeout(done, 200));
        continue;
      }
    }
    throw new Error(`Port ${targetPort} is occupied by another service or Looproom workspace. Close it or set PORT to another free port.`);
  }
}
async function incumbentPort() {
  const expectedDataDir = await realpath(dataDir).catch(() => dataDir);
  const owner = await readFile(join(expectedDataDir, "coordinator-owner.json"), "utf8").then(JSON.parse).catch(() => null);
  if (owner?.root !== root || owner?.dataDir !== expectedDataDir ||
      !Number.isInteger(owner.port) || owner.port < 1 || owner.port > 65535 || owner.port === port) return null;
  return await existingCoordinator(owner.port) ? owner.port : null;
}
async function fingerprint(directory, hash, prefix = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ignored.has(entry.name) || entry.name === ".looproom-build.json" || entry.name.startsWith(".env") || /\.(?:key|pem)$/.test(entry.name)) continue;
    const relative = join(prefix, entry.name);
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isDirectory()) await fingerprint(path, hash, relative);
    else if (info.isFile()) hash.update(relative).update("\0").update(await readFile(path)).update("\0");
  }
}
async function hashTree(path) {
  const hash = createHash("sha256");
  hash.update(process.version);
  await fingerprint(path, hash);
  return hash.digest("hex");
}
async function installedTreeHash() {
  const modules = join(root, "node_modules");
  const canonicalModules = await realpath(modules);
  const hash = createHash("sha256");
  async function visit(directory, prefix = "") {
    const entries = (await readdir(directory)).sort();
    for (const name of entries) {
      if (!prefix && name === ".looproom-install.json") continue;
      const path = join(directory, name);
      const entry = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(path);
      if (info.isDirectory()) {
        hash.update(`directory\0${entry}\0${info.mode & 0o111}\0`);
        await visit(path, entry);
      } else if (info.isFile()) {
        hash.update(`file\0${entry}\0${info.mode & 0o111}\0${info.size}\0`);
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        hash.update("\0");
      } else if (info.isSymbolicLink()) {
        const target = await readlink(path);
        const actual = await realpath(path);
        const within = relative(canonicalModules, actual);
        if (within === ".." || within.startsWith(`..${sep}`) || within.startsWith(sep))
          throw new Error(`Installed dependency link escapes node_modules: ${entry}`);
        hash.update(`symlink\0${entry}\0${target}\0`);
      } else {
        throw new Error(`Unsupported installed dependency entry: ${entry}`);
      }
    }
  }
  await visit(modules);
  return hash.digest("hex");
}
async function sourceHash() {
  const hash = createHash("sha256").update(process.version);
  for (const name of ["src", "public", "server", "scripts", "config"]) {
    if (existsSync(join(root, name))) await fingerprint(join(root, name), hash, name);
  }
  for (const name of ["index.html", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts"]) {
    hash.update(name).update("\0").update(await readFile(join(root, name))).update("\0");
  }
  return hash.digest("hex");
}
async function ensureBuild() {
  const sourceHashValue = await sourceHash();
  const dependencyHash = createHash("sha256").update(await readFile(join(root, "package-lock.json"))).digest("hex");
  const saved = await readFile(stamp, "utf8").then(JSON.parse).catch(() => null);
  const installed = await readFile(installRecord, "utf8").then(JSON.parse).catch(() => null);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const dependenciesPresent = existsSync(join(root, "node_modules", ".package-lock.json")) &&
    Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).every((name) =>
      existsSync(join(root, "node_modules", name, "package.json")));
  const installedNow = !dependenciesPresent || installed?.version !== 1 || installed?.dependencyHash !== dependencyHash ||
    !installed?.treeHash || installed.treeHash !== await installedTreeHash();
  if (installedNow) {
    requireTool("npm", ["--version"], [10, 0, 0], "npm 10 or later is required to install Looproom dependencies. Install Node.js with npm and reopen Looproom.");
    await run("npm", ["ci"]);
    if (!existsSync(join(root, "node_modules", ".package-lock.json")) ||
        Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).some((name) =>
          !existsSync(join(root, "node_modules", name, "package.json"))))
      throw new Error("npm ci completed without the required Looproom packages. Check the install output and retry.");
    await writeFile(installRecord, JSON.stringify({ version: 1, dependencyHash, treeHash: await installedTreeHash() }) + "\n");
  }
  if (!installedNow && saved?.dependencyHash === dependencyHash && saved?.sourceHash === sourceHashValue && existsSync(join(root, "dist", "index.html")) &&
      saved?.assetHash === await hashTree(join(root, "dist"))) {
    console.log("Looproom: using unchanged built assets.");
    return;
  }
  await run("npm", ["run", "build"]);
  const assetHash = await hashTree(join(root, "dist"));
  await writeFile(stamp, JSON.stringify({ sourceHash: sourceHashValue, dependencyHash, assetHash }) + "\n");
}
function run(binary, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`${binary} ${args.join(" ")} failed with exit code ${code}.`)));
  });
}
function openBrowser(targetPort = port) {
  if (process.env.LOOPROOM_NO_BROWSER === "1") return;
  const targetUrl = `http://127.0.0.1:${targetPort}`;
  const opener = spawn("/usr/bin/open", [targetUrl], { stdio: "ignore" });
  opener.on("error", (error) => console.error(`Could not open the browser: ${error.message}. Open ${targetUrl} manually.`));
}
async function waitForCoordinator(child, getSpawnError) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (getSpawnError()) throw new Error(`Could not start the coordinator: ${getSpawnError().message}`);
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Coordinator exited during startup (${child.exitCode ?? child.signalCode}). Check the terminal output above.`);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      const health = await response.json().catch(() => null);
      const expectedDataDir = await realpath(dataDir).catch(() => dataDir);
      if (health?.app !== "looproom" || health.root !== root || health.dataDir !== expectedDataDir)
        throw new Error(`Port ${port} is occupied by another service or Looproom workspace. Close it or set PORT to another free port.`);
      if (response.ok && health.status === "ok") return;
      if (response.status !== 503 || health.status !== "starting") throw new Error(`Looproom on port ${port} returned an unexpected health response.`);
    } catch (error) {
      if (error.cause?.code !== "ECONNREFUSED" && error.name !== "TimeoutError") throw error;
    }
    await pause(100);
  }
  throw new Error(`Looproom on port ${port} did not finish starting. Check its terminal for errors.`);
}
async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a number from 1 to 65535.");
  requireNode();
  const preparation = await acquirePreparationLock();
  let child;
  let childExit;
  try {
    if (await existingCoordinator()) { openBrowser(); return; }
    const incumbent = await incumbentPort();
    if (incumbent) { openBrowser(incumbent); return; }
    prerequisites();
    await ensureBuild();
    child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: root, stdio: ["inherit", "pipe", "inherit"],
    });
    let spawnError;
    childExit = new Promise((done) => {
      child.once("error", (error) => { spawnError = error; done(1); });
      child.once("exit", (code) => done(code ?? 1));
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    process.on("SIGINT", () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    await waitForCoordinator(child, () => spawnError);
    openBrowser();
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const stopped = await Promise.race([childExit.then(() => true), pause(2000).then(() => false)]);
      if (!stopped) {
        child.kill("SIGKILL");
        const killed = await Promise.race([childExit.then(() => true), pause(2000).then(() => false)]);
        if (!killed) console.error(`Coordinator process ${child.pid} did not exit after SIGKILL; check it before retrying.`);
      }
    }
    throw error;
  } finally {
    preparation.close();
  }
  const code = await childExit;
  if (code !== 0) throw new Error(`Coordinator exited with code ${code}. Check the terminal output above.`);
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(`Looproom launch failed: ${error.message}`); process.exitCode = 1; });
export { ensureBuild };
