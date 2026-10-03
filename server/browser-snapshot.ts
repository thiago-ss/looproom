import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chmod, lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

export type BrowserSnapshot = {
  id: string;
  projectId: string;
  capturedAt: string;
  hash: string;
  counts: Record<string, number>;
  eventSequence: number;
  state: any;
  review?: Record<string, FrozenPrReview>;
};

export type PrReviewBinding = { gateId: string; projectId: string; pr: string; sha: string; base: string };
export type FrozenPrReview = PrReviewBinding & { info: any; diff: string };

const kinds = ["project", "task", "gate", "agent", "message", "run", "memory"] as const;
const secretKeys = new Set(["output", "account", "accessToken", "refreshToken", "token", "cookie", "session", "databasePath", "dataDir", "codexHome"]);
function scrub(value: any, databasePath: string): any {
  if (typeof value === "string") return value.replaceAll(databasePath, "[redacted database path]");
  if (Array.isArray(value)) return value.map((item) => scrub(item, databasePath));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKeys.has(key)).map(([key, item]) => [key, scrub(item, databasePath)]));
}
function digest(value: Omit<BrowserSnapshot, "hash">) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function payload(snapshot: BrowserSnapshot): Omit<BrowserSnapshot, "hash"> {
  const { hash: _hash, ...rest } = snapshot;
  return rest;
}
function validId(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
function reviewBinding(gate: any, project: any): PrReviewBinding | null {
  const repository = /^([\w.-]+)\/([\w.-]+)$/.exec(project.github ?? "");
  const pr = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(gate?.pr ?? "");
  if (gate?.type !== "pr" || gate?.status !== "open" || gate?.projectId !== project.id ||
      typeof gate.id !== "string" || !repository || !pr || pr[1] !== repository[1] || pr[2] !== repository[2] ||
      !/^[a-f0-9]{40}$/.test(gate.sha ?? "") || typeof project.branch !== "string" ||
      !project.branch || project.branch.length > 256 || (gate.base != null && gate.base !== project.branch)) return null;
  return { gateId: gate.id, projectId: project.id, pr: gate.pr, sha: gate.sha, base: project.branch };
}
function validReview(binding: PrReviewBinding, review: FrozenPrReview) {
  const number = Number(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d*)$/.exec(binding.pr)?.[1]);
  return review && review.gateId === binding.gateId && review.projectId === binding.projectId &&
    review.pr === binding.pr && review.sha === binding.sha && review.base === binding.base &&
    review.info?.url === binding.pr && review.info?.headRefOid === binding.sha &&
    review.info?.baseRefName === binding.base && review.info?.number === number && review.info?.state === "OPEN" &&
    /^[a-f0-9]{40}$/.test(review.info?.baseRefOid ?? "") && typeof review.diff === "string" && !!review.diff.trim() &&
    Buffer.byteLength(review.diff, "utf8") <= 2_000_000 &&
    Buffer.byteLength(JSON.stringify(review.info), "utf8") <= 500_000;
}

export async function captureBrowserSnapshot(options: { databasePath: string; projectId: string; directory: string; capturePrReview?: (binding: PrReviewBinding) => Promise<{ info: any; diff: string }> }): Promise<BrowserSnapshot> {
  const db = new DatabaseSync(options.databasePath, { readOnly: true, timeout: 5000 });
  let state: any;
  let eventSequence = 0;
  let indexedProjects = 0;
  let indexedMemoryRows = 0;
  try {
    db.exec("BEGIN");
    const rows = db.prepare("SELECT kind,data FROM records ORDER BY rowid").all() as { kind: string; data: string }[];
    const selected = Object.fromEntries(kinds.map((kind) => [kind + "s", [] as any[]])) as Record<string, any[]>;
    // Keep the UI's irregular plural keys explicit.
    selected.memory = selected.memorys;
    delete selected.memorys;
    for (const row of rows) {
      if (!(kinds as readonly string[]).includes(row.kind)) continue;
      const record = JSON.parse(row.data);
      if (row.kind === "project" ? record.id !== options.projectId : record.projectId !== options.projectId) continue;
      const key = row.kind === "memory" ? "memory" : row.kind + "s";
      selected[key].push(scrub(record, options.databasePath));
    }
    if (selected.projects.length !== 1) throw new Error("Snapshot project not found.");
    selected.messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || Number(b.kind === "escalation") - Number(a.kind === "escalation"));
    const eventRows = db.prepare("SELECT seq,project_id,type,data,created_at FROM events WHERE project_id=? ORDER BY seq DESC LIMIT 80").all(options.projectId) as any[];
    eventSequence = eventRows[0]?.seq ?? 0;
    const settings = db.prepare("SELECT data FROM records WHERE id='settings' AND kind='settings'").get() as { data: string } | undefined;
    const indexStats = db.prepare("SELECT count(*) AS rows, count(DISTINCT project_id) AS projects FROM memory_search").get() as { rows: number; projects: number };
    indexedProjects = indexStats.projects;
    indexedMemoryRows = indexStats.rows;
    state = { ...selected, events: eventRows.map((row) => ({ ...row, data: scrub(JSON.parse(row.data), options.databasePath) })), settings: settings ? scrub(JSON.parse(settings.data), options.databasePath) : {}, runtime: { connected: false, account: null, models: [], error: "Read-only browser snapshot" } };
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
    throw error;
  } finally {
    db.close();
  }
  const counts = Object.fromEntries(kinds.map((kind) => [kind, state[kind === "memory" ? "memory" : kind + "s"].length]));
  counts.openGates = state.gates.filter((g: any) => g.status === "open").length;
  counts.citedSources = new Set(state.memory.flatMap((m: any) => m.sources ?? []).map((v: unknown) => JSON.stringify(v))).size;
  counts.indexedProjects = indexedProjects;
  counts.indexedMemoryRows = indexedMemoryRows;
  const review: Record<string, FrozenPrReview> = {};
  if (options.capturePrReview) for (const gate of state.gates) {
    const binding = reviewBinding(gate, state.projects[0]);
    if (!binding) continue;
    const captured = await options.capturePrReview(binding);
    const frozen = { ...binding, info: scrub(captured?.info, options.databasePath), diff: scrub(captured?.diff, options.databasePath) } as FrozenPrReview;
    if (!validReview(binding, frozen)) throw new Error("PR review capture does not match the selected gate URL, head, and base, or exceeds snapshot limits.");
    review[gate.id] = frozen;
  }
  const base = { id: randomUUID(), projectId: options.projectId, capturedAt: new Date().toISOString(), counts, eventSequence, state, ...(Object.keys(review).length ? { review } : {}) };
  const snapshot: BrowserSnapshot = { ...base, hash: digest(base) };
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const file = join(options.directory, snapshot.id + ".json");
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(snapshot) + "\n"); } finally { await handle.close(); }
  await chmod(file, 0o400);
  return snapshot;
}

export async function loadBrowserSnapshot(directory: string, id: string, projectId: string): Promise<BrowserSnapshot> {
  if (!validId(id)) throw new Error("Invalid snapshot ID.");
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error("Snapshot directory must be a real directory.");
  const file = join(directory, id + ".json");
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Snapshot file must be a real file.");
  const snapshot = JSON.parse(await readFile(file, "utf8")) as BrowserSnapshot;
  if (snapshot.id !== id || snapshot.projectId !== projectId || typeof snapshot.hash !== "string" || digest(payload(snapshot)) !== snapshot.hash) throw new Error("Snapshot identity or hash mismatch.");
  if (snapshot.state?.projects?.length !== 1 || snapshot.state.projects[0]?.id !== projectId) throw new Error("Snapshot project mismatch.");
  if (snapshot.review) for (const [gateId, review] of Object.entries(snapshot.review)) {
    const binding = reviewBinding(snapshot.state.gates.find((gate: any) => gate.id === gateId), snapshot.state.projects[0]);
    if (!binding || !validReview(binding, review)) throw new Error("Snapshot PR review does not match its project gate revision.");
  }
  return snapshot;
}

const securityHeaders = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; media-src 'self' data:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...securityHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function startBrowserViewer(options: { snapshot: BrowserSnapshot; distDir: string }): Promise<{ url: string; close(): Promise<void> }> {
  const snapshot = options.snapshot;
  if (!validId(snapshot.id) || digest(payload(snapshot)) !== snapshot.hash) throw new Error("Invalid browser snapshot.");
  if (snapshot.review) for (const [gateId, review] of Object.entries(snapshot.review)) {
    const binding = reviewBinding(snapshot.state.gates.find((gate: any) => gate.id === gateId), snapshot.state.projects[0]);
    if (!binding || !validReview(binding, review)) throw new Error("Invalid browser PR review evidence.");
  }
  const capability = randomBytes(32).toString("hex");
  const capabilityBytes = Buffer.from(capability);
  const authorized = (cookieHeader: string | undefined) => {
    const value = cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith("audit_snapshot="))?.slice("audit_snapshot=".length);
    if (!value || !/^[0-9a-f]{64}$/.test(value)) return false;
    return timingSafeEqual(Buffer.from(value), capabilityBytes);
  };
  const dist = await realpath(options.distDir);
  const searchDb = new DatabaseSync(":memory:");
  searchDb.exec("CREATE VIRTUAL TABLE memory_search USING fts5(id UNINDEXED, project_id UNINDEXED, title, content)");
  const insert = searchDb.prepare("INSERT INTO memory_search(id,project_id,title,content) VALUES(?,?,?,?)");
  for (const page of snapshot.state.memory) insert.run(page.id, snapshot.projectId, page.title, page.content);
  const pages = new Map<string, any>(snapshot.state.memory.map((page: any) => [page.id, page]));
  const server = createServer(async (req, res) => {
    try {
      const ownOrigin = `http://127.0.0.1:${req.socket.localPort}`;
      const requestUrl = new URL(req.url ?? "/", ownOrigin);
      // Chrome sends absolute-form targets through an HTTP proxy. This viewer
      // serves its own origin only and never forwards a target or CONNECT tunnel.
      if (requestUrl.origin !== ownOrigin || req.headers.host !== new URL(ownOrigin).host) { json(res, 403, { error: "Foreign proxy target denied." }); return; }
      const path = decodeURIComponent(requestUrl.pathname);
      if (req.method !== "GET" && req.method !== "HEAD") { json(res, 405, { error: "Read-only browser snapshot." }); return; }
      if (path === "/" && req.method === "GET" && requestUrl.searchParams.get("audit") === capability) {
        res.writeHead(302, { ...securityHeaders, "cache-control": "no-store", "set-cookie": `audit_snapshot=${capability}; HttpOnly; SameSite=Strict; Path=/api`, location: "/" });
        res.end();
        return;
      }
      if ((path === "/api" || path.startsWith("/api/")) && !authorized(req.headers.cookie)) { json(res, 403, { error: "Snapshot access denied." }); return; }
      if (path === "/api/state") { json(res, 200, { ...snapshot.state, events: requestUrl.searchParams.get("events") === "1" ? snapshot.state.events : [] }); return; }
      if (path === "/api/events") { res.writeHead(200, { ...securityHeaders, "content-type": "text/event-stream", "cache-control": "no-store" }); res.end("data: connected\n\n"); return; }
      const prReview = /^\/api\/gates\/([^/]+)\/(pr|diff)$/.exec(path);
      if (prReview) {
        const review = snapshot.review?.[prReview[1]];
        const binding = reviewBinding(snapshot.state.gates.find((gate: any) => gate.id === prReview[1]), snapshot.state.projects[0]);
        if (!review || !binding || !validReview(binding, review)) { json(res, 404, { error: "PR review unavailable in browser snapshot." }); return; }
        json(res, 200, prReview[2] === "pr" ? review.info : { diff: review.diff }); return;
      }
      const memory = /^\/api\/projects\/([^/]+)\/memory$/.exec(path);
      if (memory) {
        if (memory[1] !== snapshot.projectId) { json(res, 404, { error: "Project not found." }); return; }
        const terms = (requestUrl.searchParams.get("q") ?? "").match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 12).map((term) => '"' + term.replaceAll('"', '""') + '"').join(" OR ");
        if (!terms) { json(res, 200, snapshot.state.memory); return; }
        const results = searchDb.prepare("SELECT id FROM memory_search WHERE memory_search MATCH ? AND project_id=? ORDER BY rank LIMIT 20").all(terms, snapshot.projectId) as { id: string }[];
        json(res, 200, results.map((row) => pages.get(row.id))); return;
      }
      if (path === "/api" || path.startsWith("/api/")) { json(res, 404, { error: "Unavailable in browser snapshot." }); return; }
      const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
      const candidate = resolve(dist, relative);
      if (candidate !== dist && !candidate.startsWith(dist + sep)) { json(res, 404, { error: "Not found." }); return; }
      const extension = extname(candidate);
      const target = extension ? candidate : join(dist, "index.html");
      const actual = await realpath(target).catch(() => "");
      if (!actual || (actual !== dist && !actual.startsWith(dist + sep)) || !(await stat(actual)).isFile()) { json(res, 404, { error: "Not found." }); return; }
      const contentType: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".ico": "image/x-icon" };
      res.writeHead(200, { ...securityHeaders, "content-type": contentType[extname(actual)] ?? "application/octet-stream", "cache-control": path.startsWith("/assets/") ? "private, max-age=3600, immutable" : "no-store" });
      res.end(req.method === "HEAD" ? undefined : await readFile(actual));
    } catch { json(res, 404, { error: "Unavailable in browser snapshot." }); }
  });
  const denyTunnel = (_req: unknown, socket: import("node:net").Socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  };
  server.on("connect", denyTunnel);
  server.on("upgrade", denyTunnel);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  } catch (error) { searchDb.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Viewer has no TCP address.");
  return { url: `http://127.0.0.1:${address.port}/?audit=${capability}`, close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); searchDb.close(); } };
}
