import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { cpus, totalmem, version as osVersion } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { sourceFingerprint, runVerification } from "./verification.ts";
import { captureBrowserSnapshot, loadBrowserSnapshot, startBrowserViewer } from "./browser-snapshot.ts";
import { needsHumanReview } from "../src/lib/autonomy.ts";

const execFileAsync = promisify(execFile);
const VIEWPORTS = [{ width: 1280, height: 800 }, { width: 390, height: 844 }] as const;
const WORKFLOWS = ["goal", "work", "review", "memory"] as const;
const REQUIRED = ["goal.load", "goal.scroll", "goal.latest", "goal.context", "work.open", "work.connections", "work.task", "work.navigation", "work.filter", "work.search", "review.open", "review.context", "memory.open", "memory.outcome", "memory.search", "memory.clear", "memory.sources"] as const;
const CHECKPOINTS = ["Goal conversation", "Latest messages", "Context", "Context return", "Work", "Connections", "Workstream", "Inspect task", "Next task", "Previous task", "Filter tasks by state", "Search tasks", "Review", "Decision gate", "Memory", "Outcome", "Search project memory", "Sources", "Library"] as const;
const PR_CHECKPOINTS = ["Change summary", "Full diff", "Approve & merge", "Merge dialog", "Merge dialog return"] as const;
const CONTRACT = { version: 1, viewports: VIEWPORTS, workflows: WORKFLOWS, required: REQUIRED,
  checkpoints: CHECKPOINTS, prCheckpoints: PR_CHECKPOINTS, warmup: 1, repetitions: 5, budgetMs: 1_800_000, percentile: "nearest-rank", cache: "one context, fresh tab, warm after first load",
  keep: { targetRelative: 0.1, targetAbsoluteMs: 50, otherMaximumRegression: 0.1 } } as const;
export const BROWSER_PROTOCOL_HASH = createHash("sha256").update(JSON.stringify(CONTRACT)).digest("hex");
const token = (s: unknown) => String(s ?? "").match(/[\p{L}\p{N}_-]{3,}/u)?.[0] ?? "";
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const pathSafe = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

export type BrowserOperation = { name: string; durationMs: number; maxLongTaskMs: number | null; focus: string | null; focusVisible: boolean | null; focusClipped: boolean | null; horizontalOverflow: boolean | null };
export type BrowserSample = { viewport: "desktop" | "mobile"; repetition: number; warmup: boolean; operations: BrowserOperation[]; navigation: { domContentLoadedMs: number | null; transferBytes: number | null; resourceBytes: number | null; cachedAssetCount: number | null }; keyboard: { checkpoint: string; focused: string | null; focusVisible: boolean | null; clipped: boolean | null; reached: boolean }[]; errors: string[]; unavailable: string[]; screenshot?: string };
export type BrowserAuditReport = { id: string; kind: "browser-baseline"; projectId: string; runId?: string; sourceHash: string; sourceSha: string | null; sourceUnchanged: boolean; buildHash: string | null; snapshotId: string | null; snapshotHash: string | null; protocolHash: string; evaluatorHash: string; createdAt: string; reportPath: string; measurementDurationMs: number | null; status: "complete" | "unavailable"; unavailable: string[]; environment: Record<string, unknown>; observations: { samples: BrowserSample[]; aggregates: Record<string, { rawMs: number[]; p75Ms: number; medianMs: number; maximumLongTaskMs: number | null }> }; artifacts: string[]; artifactHashes: Record<string, string> };

export function percentile(values: number[], p: number): number {
  if (!values.length || values.some(v => !Number.isFinite(v) || v < 0)) throw new Error("Invalid timing series");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function validateBrowserReport(report: BrowserAuditReport): string[] {
  const errors: string[] = [];
  const sha = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  const metric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (report.kind !== "browser-baseline" || !uuid(report.id) || !uuid(report.projectId) || (report.runId && !uuid(report.runId))) errors.push("Report identity unavailable");
  if (report.protocolHash !== BROWSER_PROTOCOL_HASH) errors.push("Protocol hash changed");
  if (!sha(report.evaluatorHash)) errors.push("Evaluator source hash unavailable");
  if (!report.sourceUnchanged || !sha(report.sourceHash) || !/^[a-f0-9]{40}$/.test(report.sourceSha ?? "") || !sha(report.buildHash)) errors.push("Source/build identity unavailable or changed");
  if (!uuid(report.snapshotId) || !sha(report.snapshotHash)) errors.push("Snapshot identity unavailable");
  const env = report.environment ?? {};
  if (!env.browserVersion || !env.playwrightVersion) errors.push("Browser identity unavailable");
  if (!env.macProductVersion || !sha(env.packageLockHash) || !uuid(env.buildReportId) || !env.osVersion || !env.processor || !metric(env.memoryBytes) || env.deviceScaleFactor !== 1) errors.push("Mac/package/build provenance unavailable");
  if (!["pr", "non-pr", "none"].includes(String(env.reviewGateType))) errors.push("Review case identity unavailable");
  const samples = report.observations?.samples ?? [];
  const artifacts = report.artifacts ?? [];
  if (!artifacts.some(p => p.endsWith("trace.zip")) || new Set(artifacts).size !== artifacts.length || artifacts.some(p => !sha(report.artifactHashes?.[p])) || samples.some(s => !s.screenshot || !artifacts.includes(s.screenshot) || !sha(report.artifactHashes?.[s.screenshot]))) errors.push("Trace or screenshot hash unavailable");
  if (!metric(report.measurementDurationMs) || report.measurementDurationMs > CONTRACT.budgetMs) errors.push("Measurement budget unavailable or exceeded");
  if (samples.length !== 12) errors.push("Unexpected sample count");
  for (const viewport of ["desktop", "mobile"] as const) {
    const selected = samples.filter(s => s.viewport === viewport);
    if (selected.length !== 6 || [...selected].sort((a,b) => a.repetition-b.repetition).some((s,i) => s.repetition !== i || s.warmup !== (i === 0))) errors.push(`${viewport}: expected one warm-up and five uniquely numbered samples`);
    for (const s of selected) {
      if (s.unavailable.length) errors.push(`${viewport}/${s.repetition}: unavailable observations`);
      if (!metric(s.navigation.domContentLoadedMs) || !metric(s.navigation.transferBytes) || !metric(s.navigation.resourceBytes) || !Number.isInteger(s.navigation.cachedAssetCount) || !metric(s.navigation.cachedAssetCount) || (!s.warmup && s.navigation.cachedAssetCount < 1)) errors.push(`${viewport}/${s.repetition}: navigation/resource timing or warm cache unavailable`);
      if (new Set(s.operations.map(o => o.name)).size !== s.operations.length || new Set(s.keyboard.map(k => k.checkpoint)).size !== s.keyboard.length) errors.push(`${viewport}/${s.repetition}: duplicate observations`);
      for (const checkpoint of [...CHECKPOINTS, ...(env.reviewGateType === "pr" ? PR_CHECKPOINTS : [])]) if (!s.keyboard.some(k => k.checkpoint === checkpoint && typeof k.reached === "boolean" && typeof k.focusVisible === "boolean" && typeof k.clipped === "boolean" && typeof k.focused === "string")) errors.push(`${viewport}/${s.repetition}: ${checkpoint} keyboard checkpoint missing`);
      for (const name of REQUIRED) if (!s.operations.some(o => o.name === name && metric(o.durationMs) && metric(o.maxLongTaskMs) && typeof o.horizontalOverflow === "boolean" && typeof o.focusVisible === "boolean" && typeof o.focusClipped === "boolean" && typeof o.focus === "string")) errors.push(`${viewport}/${s.repetition}: ${name} missing`);
    }
  }
  for (const name of REQUIRED) for (const viewport of ["desktop", "mobile"]) {
    const aggregate = report.observations?.aggregates?.[`${viewport}.${name}`];
    const measured = samples.filter(s => s.viewport === viewport && !s.warmup).sort((a,b) => a.repetition-b.repetition).map(s => s.operations.find(o => o.name === name)?.durationMs);
    const longTasks = samples.filter(s => s.viewport === viewport && !s.warmup).map(s => s.operations.find(o => o.name === name)?.maxLongTaskMs);
    if (!aggregate || !Array.isArray(aggregate.rawMs) || aggregate.rawMs.length !== 5 || aggregate.rawMs.some(v => !metric(v)) || measured.length !== 5 || measured.some((v,i) => v !== aggregate.rawMs[i]) || percentile(aggregate.rawMs, .75) !== aggregate.p75Ms || percentile(aggregate.rawMs, .5) !== aggregate.medianMs || !metric(aggregate.maximumLongTaskMs) || longTasks.some(v => !metric(v)) || Math.max(...longTasks as number[]) !== aggregate.maximumLongTaskMs) errors.push(`${viewport}.${name}: invalid aggregate`);
  }
  return [...new Set(errors)];
}

export function compareBrowserReports(baseline: BrowserAuditReport, candidate: BrowserAuditReport, target: string): { decision: "keep" | "discard" | "unavailable"; reasons: string[] } {
  const reasons = [...validateBrowserReport(baseline).map(x => `baseline: ${x}`), ...validateBrowserReport(candidate).map(x => `candidate: ${x}`)];
  if ([baseline, candidate].some(r => r.status !== "complete" || r.unavailable.length)) reasons.push("Report is unavailable");
  if (baseline.snapshotHash !== candidate.snapshotHash || baseline.snapshotId !== candidate.snapshotId || baseline.projectId !== candidate.projectId) reasons.push("Snapshot differs");
  if (baseline.protocolHash !== candidate.protocolHash) reasons.push("Evaluator differs");
  if (baseline.evaluatorHash !== candidate.evaluatorHash) reasons.push("Evaluator source differs");
  for (const key of ["browserVersion", "playwrightVersion", "osVersion", "macProductVersion", "processor", "memoryBytes", "deviceScaleFactor", "reviewGateType"]) if (baseline.environment[key] !== candidate.environment[key]) reasons.push(`Environment differs: ${key}`);
  if (!REQUIRED.includes(target as typeof REQUIRED[number])) reasons.push("Target is not a measured operation");
  if (reasons.length) return { decision: "unavailable", reasons: [...new Set(reasons)] };
  for (const viewport of ["desktop", "mobile"] as const) {
    const beforeSamples = baseline.observations.samples.filter(s => s.viewport === viewport && !s.warmup);
    const afterSamples = candidate.observations.samples.filter(s => s.viewport === viewport && !s.warmup);
    const failures = (samples: BrowserSample[]) => new Set(samples.flatMap(s => [
      ...s.errors.map(e => `error:${e}`),
      ...s.keyboard.filter(k => !k.reached || k.focusVisible !== true).map(k => `keyboard:${k.checkpoint}`),
      ...s.operations.filter(o => o.horizontalOverflow).map(o => `overflow:${o.name}`),
      ...s.operations.filter(o => o.focusClipped).map(o => `clipping:${o.name}`),
      ...s.keyboard.filter(k => k.clipped).map(k => `clipping:${k.checkpoint}`),
    ]));
    const existingFailures = failures(beforeSamples);
    for (const failure of failures(afterSamples)) if (!existingFailures.has(failure)) reasons.push(`${viewport}: new ${failure}`);
    const key = `${viewport}.${target}`, before = baseline.observations.aggregates[key].p75Ms, after = candidate.observations.aggregates[key].p75Ms;
    if (before - after < 50 || after > before * .9) reasons.push(`${key}: target missed 10% and 50 ms improvement`);
    for (const name of REQUIRED) {
      const k = `${viewport}.${name}`;
      if (name !== target && candidate.observations.aggregates[k].p75Ms > baseline.observations.aggregates[k].p75Ms * 1.1) reasons.push(`${k}: more than 10% regression`);
    }
  }
  return { decision: reasons.length ? "discard" : "keep", reasons };
}

async function focus(page: Page) { return page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return { focused: null, visible: null, clipped: null };
  const focused = el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 100) || el.tagName.toLowerCase();
  const style = getComputedStyle(el), rect = el.getBoundingClientRect();
  const inView = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && style.visibility === "visible" && style.display !== "none" && Number(style.opacity) > 0;
  const painted = (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== "transparent") || (style.boxShadow !== "none" && style.boxShadow !== "");
  const visible = inView && painted;
  let clipped = rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth;
  for (let parent = el.parentElement; parent && !clipped; parent = parent.parentElement) {
    const s = getComputedStyle(parent);
    if ([s.overflowX, s.overflowY].some(v => ["hidden", "clip", "auto", "scroll"].includes(v))) {
      const r = parent.getBoundingClientRect();
      clipped = rect.left < r.left - 1 || rect.right > r.right + 1 || rect.top < r.top - 1 || rect.bottom > r.bottom + 1;
    }
  }
  return { focused, visible, clipped };
}); }
async function keyboardReach(page: Page, locator: Locator, label: string, sample: BrowserSample): Promise<boolean> {
  if (await locator.count() !== 1) { const f = await focus(page); sample.keyboard.push({ checkpoint: label, focused: f.focused, focusVisible: f.visible, clipped: f.clipped, reached: false }); sample.unavailable.push(`Keyboard target ambiguous or missing: ${label}`); return false; }
  if (await locator.evaluate(e => e === document.activeElement)) {
    const f = await focus(page); sample.keyboard.push({ checkpoint: label, focused: f.focused, focusVisible: f.visible, clipped: f.clipped, reached: true });
    return true;
  }
  const target = await locator.elementHandle();
  const route = await page.evaluate(element => {
    const candidates = [...document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')].filter(node => {
      const style = getComputedStyle(node);
      return node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length > 0 && style.display !== 'none' && style.visibility === 'visible';
    });
    candidates.sort((a, b) => {
      const aPositive = a.tabIndex > 0, bPositive = b.tabIndex > 0;
      if (aPositive !== bPositive) return aPositive ? -1 : 1;
      if (aPositive && a.tabIndex !== b.tabIndex) return a.tabIndex - b.tabIndex;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    const from = candidates.indexOf(document.activeElement as HTMLElement), to = candidates.indexOf(element as HTMLElement);
    const forward = from >= 0 && to >= 0 ? (to - from + candidates.length) % candidates.length : Infinity;
    const backward = from >= 0 && to >= 0 ? (from - to + candidates.length) % candidates.length : Infinity;
    const current = document.activeElement;
    const targetPrecedesDetachedFocus = from < 0 && current?.isConnected && current !== document.body && !!((element as Element).compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { key: to >= 0 && (backward < forward || targetPrecedesDetachedFocus) ? 'Shift+Tab' : 'Tab', limit: Math.min(1200, candidates.length * 2 + 16) };
  }, target);
  await target?.dispose();
  const limit = route.limit;
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press(route.key);
    const f = await focus(page);
    if (await locator.evaluate(e => e === document.activeElement)) {
      sample.keyboard.push({ checkpoint: label, focused: f.focused, focusVisible: f.visible, clipped: f.clipped, reached: true });
      return true;
    }
  }
  const f = await focus(page); sample.keyboard.push({ checkpoint: label, focused: f.focused, focusVisible: f.visible, clipped: f.clipped, reached: false });
  return false;
}
async function recordFocus(page: Page, locator: Locator, label: string, sample: BrowserSample) {
  const f = await focus(page);
  sample.keyboard.push({ checkpoint: label, focused: f.focused, focusVisible: f.visible, clipped: f.clipped,
    reached: await locator.count() === 1 && await locator.evaluate(e => e === document.activeElement) });
}
async function activate(page: Page, locator: Locator, label: string, sample: BrowserSample) {
  const reached = await keyboardReach(page, locator, label, sample);
  await page.evaluate(() => performance.mark("looproom-activation"));
  if (reached) await page.keyboard.press("Enter");
  else if (await locator.count() === 1 && await locator.isEnabled()) await locator.click();
}
async function activateRovingTab(page: Page, active: Locator, target: Locator, label: string, sample: BrowserSample, key: "ArrowRight" | "ArrowLeft") {
  if (await active.count() !== 1 || await target.count() !== 1) throw new Error(`Tab target missing or ambiguous: ${label}`);
  const activeHandle = await active.elementHandle();
  const sameList = await target.evaluate((element, other) => element.closest('[role="tablist"]') === (other as Element).closest('[role="tablist"]'), activeHandle);
  await activeHandle?.dispose();
  if (!sameList || !await active.evaluate(element => element === document.activeElement && element.getAttribute("aria-selected") === "true")) {
    throw new Error(`Native tab starting point unavailable: ${label}`);
  }
  await page.evaluate(() => performance.mark("looproom-activation"));
  await page.keyboard.press(key);
  const targetHandle = await target.elementHandle();
  await page.waitForFunction(element => element === document.activeElement && (element as Element).getAttribute("aria-selected") === "true", targetHandle, { timeout: 1500 });
  await targetHandle?.dispose();
  await recordFocus(page, target, label, sample);
}
async function restoreRovingTab(page: Page, target: Locator) {
  await page.keyboard.press("ArrowLeft");
  const targetHandle = await target.elementHandle();
  await page.waitForFunction(element => element === document.activeElement && (element as Element).getAttribute("aria-selected") === "true", targetHandle, { timeout: 1500 });
  await targetHandle?.dispose();
}
async function measure(page: Page, sample: BrowserSample, name: string, action: () => Promise<void>, settled: () => Promise<void>) {
  await page.evaluate(() => performance.mark("looproom-activation"));
  await action();
  await settled();
  const m = await page.evaluate(() => {
    performance.mark("looproom-settled"); performance.measure("looproom-operation", "looproom-activation", "looproom-settled");
    const tasks = (window as any).__looproomLongTasks as { startTime: number; duration: number }[] | null;
    const start = performance.getEntriesByName("looproom-activation", "mark").at(-1)?.startTime ?? NaN;
    const el = document.activeElement as HTMLElement | null;
    const style = el ? getComputedStyle(el) : null;
    const rect = el?.getBoundingClientRect();
    const inView = !!(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && style?.visibility === "visible" && style.display !== "none" && Number(style.opacity) > 0);
    const painted = !!(style && ((style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== "transparent") || (style.boxShadow !== "none" && style.boxShadow !== "")));
    let clipped = !!(rect && (rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth));
    for (let parent = el?.parentElement; parent && !clipped; parent = parent.parentElement) {
      const s = getComputedStyle(parent);
      if ([s.overflowX, s.overflowY].some(v => ["hidden", "clip", "auto", "scroll"].includes(v))) {
        const r = parent.getBoundingClientRect();
        clipped = !!(rect && (rect.left < r.left - 1 || rect.right > r.right + 1 || rect.top < r.top - 1 || rect.bottom > r.bottom + 1));
      }
    }
    return { durationMs: performance.now() - start, maxLongTaskMs: tasks ? Math.max(0, ...tasks.filter(t => t.startTime >= start).map(t => t.duration)) : null,
      focus: el?.getAttribute("aria-label") || el?.textContent?.trim().slice(0, 100) || el?.tagName.toLowerCase() || "document",
      focusVisible: el ? inView && painted : null,
      focusClipped: clipped,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
  sample.operations.push({ name, ...m });
  if (m.maxLongTaskMs === null) sample.unavailable.push(`Long-task API unavailable: ${name}`);
  const dropped = await page.evaluate(() => (window as any).__looproomDroppedLongTasks as number | undefined);
  if (dropped) sample.unavailable.push(`Long-task entries dropped: ${dropped}`);
}

async function measureNavigation(page: Page, sample: BrowserSample, url: string) {
  const before = await page.evaluate(() => performance.timeOrigin + performance.now());
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Goal", exact: true }).waitFor();
  await page.locator(".conversation-flow .message").first().waitFor();
  const observed = await page.evaluate(() => {
    performance.mark("looproom-goal-settled");
    const tasks = (window as any).__looproomLongTasks as { startTime: number; duration: number }[] | null;
    const el = document.activeElement as HTMLElement | null;
    const rect = el?.getBoundingClientRect();
    return { after: performance.timeOrigin + performance.now(), maxLongTaskMs: tasks ? Math.max(0, ...tasks.map(t => t.duration)) : null,
      focus: el?.getAttribute("aria-label") || el?.textContent?.trim().slice(0, 100) || el?.tagName.toLowerCase() || "document",
      focusVisible: el ? (() => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0 && ((s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 && s.outlineColor !== "transparent") || s.boxShadow !== "none"); })() : null,
      focusClipped: !!(rect && (rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth)),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
  sample.operations.push({ name: "goal.load", durationMs: Math.max(0, observed.after - before), maxLongTaskMs: observed.maxLongTaskMs,
    focus: observed.focus, focusVisible: observed.focusVisible, focusClipped: observed.focusClipped, horizontalOverflow: observed.horizontalOverflow });
  if (observed.maxLongTaskMs === null) sample.unavailable.push("Long-task API unavailable: goal.load");
}

export async function runBrowserSample(page: Page, sample: BrowserSample, snapshot: any, url: string) {
  const projectId = snapshot.projectId;
  const tasks = (snapshot.state?.tasks ?? []).filter((t: any) => t.projectId === projectId);
  const gates = (snapshot.state?.gates ?? []).filter((g: any) => g.projectId === projectId && needsHumanReview(g, snapshot.state.projects[0]));
  const memory = (snapshot.state?.memory ?? []).filter((m: any) => m.projectId === projectId);
  await page.addInitScript(() => {
    (window as any).__looproomLongTasks = null;
    (window as any).__looproomDroppedLongTasks = 0;
    (window as any).__looproomResourceOverflow = false;
    performance.setResourceTimingBufferSize(10_000);
    performance.addEventListener("resourcetimingbufferfull", () => { (window as any).__looproomResourceOverflow = true; });
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      (window as any).__looproomLongTasks = [];
      new PerformanceObserver((...args) => { const list = args[0], options = (args as any)[2]; for (const e of list.getEntries()) (window as any).__looproomLongTasks.push({ startTime: e.startTime, duration: e.duration }); (window as any).__looproomDroppedLongTasks += options?.droppedEntriesCount ?? 0; }).observe({ type: "longtask", buffered: true });
    }
  });
  await measureNavigation(page, sample, url);
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    return { domContentLoadedMs: n?.domContentLoadedEventEnd ?? null, transferBytes: n?.transferSize ?? null,
      resourceBytes: resources.length ? resources.reduce((v, r) => v + r.transferSize, 0) : null,
      cachedAssetCount: resources.filter(r => /\.(?:js|css|woff2)(?:\?|$)/.test(r.name) && r.transferSize === 0 && r.decodedBodySize > 0).length };
  }); sample.navigation = nav;
  if (await page.evaluate(() => !!(window as any).__looproomResourceOverflow)) sample.unavailable.push("Resource timing buffer overflow");
  await measure(page, sample, "goal.scroll", async () => {
    const region = page.getByRole("region", { name: "Goal conversation" });
    if (await keyboardReach(page, region, "Goal conversation", sample)) { await page.evaluate(() => performance.mark("looproom-activation")); await page.keyboard.press("Home"); }
    else { await page.evaluate(() => performance.mark("looproom-activation")); await region.evaluate((e: HTMLElement) => { e.scrollTop = 0; }); }
  }, async () => { await page.getByRole("button", { name: "Latest messages" }).waitFor(); });
  const latestButton = page.locator('.conversation .latest-message');
  try {
    await measure(page, sample, "goal.latest", () => activate(page, latestButton, "Latest messages", sample), async () => { await latestButton.waitFor({ state: "hidden", timeout: 1500 }); });
  } catch (error) {
    sample.errors.push(`Latest messages activation did not settle: ${errorText(error)}`);
    sample.unavailable.push("goal.latest activation-to-settled timing unavailable");
    if (await latestButton.isVisible()) {
      await latestButton.click();
      await latestButton.waitFor({ state: "hidden", timeout: 3000 }).catch(() => sample.unavailable.push("Latest messages pointer recovery did not settle"));
    }
  }
  const contextButton = page.locator('.goal-toolbar .context-toggle');
  await measure(page, sample, "goal.context", () => activate(page, contextButton, "Context", sample), async () => { await page.locator(".goal-context-popover").waitFor(); await page.keyboard.press("Escape"); await page.locator(".goal-context-popover").waitFor({ state: "hidden" }); });
  await recordFocus(page, contextButton, "Context return", sample);
  await measure(page, sample, "work.open", () => activate(page, page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Work" }), "Work", sample), async () => { await page.getByRole("heading", { name: "Work", exact: true }).waitFor(); await page.locator(".work-overview").waitFor(); });
  const workstreamTab = page.getByRole("tab", { name: "Workstream" });
  const connectionsTab = page.getByRole("tab", { name: "Connections" });
  if (!await keyboardReach(page, workstreamTab, "Workstream", sample)) throw new Error("Selected Workstream tab cannot be reached by native Tab");
  await measure(page, sample, "work.connections", () => activateRovingTab(page, workstreamTab, connectionsTab, "Connections", sample, "ArrowRight"), async () => { await page.locator('.work-connections-panel[data-state="active"]').waitFor(); });
  await restoreRovingTab(page, workstreamTab);
  if (!tasks.length) { sample.unavailable.push("Work task unavailable"); return; }
  const alternateTask = page.locator('.work-record[aria-pressed="false"]').first();
  if (await alternateTask.count()) {
    const taskLabel = await alternateTask.getAttribute("aria-label");
    await measure(page, sample, "work.task", () => activate(page, alternateTask, "Inspect task", sample), async () => {
      await page.waitForFunction(label => [...document.querySelectorAll('.work-record')].some(b => b.getAttribute('aria-label') === label && b.getAttribute('aria-pressed') === 'true'), taskLabel);
      await page.getByRole("complementary", { name: "Selected task" }).waitFor();
    });
  } else {
    sample.unavailable.push("Work selection transition unavailable: only one task");
    await keyboardReach(page, page.locator('.work-record').first(), "Inspect task", sample);
  }
  const next = page.getByRole("button", { name: "Next task" }), previous = page.getByRole("button", { name: "Previous task" });
  if (tasks.length > 1 && (await next.isEnabled() || await previous.isEnabled())) {
    const forward = await next.isEnabled(), primary = forward ? next : previous, secondary = forward ? previous : next;
    const selectedBefore = await page.locator('.work-record[aria-pressed="true"]').getAttribute("aria-label");
    await measure(page, sample, "work.navigation", () => activate(page, primary, forward ? "Next task" : "Previous task", sample), async () => {
      await page.waitForFunction(before => document.querySelector('.work-record[aria-pressed="true"]')?.getAttribute('aria-label') !== before, selectedBefore);
    });
    await activate(page, secondary, forward ? "Previous task" : "Next task", sample);
  } else sample.unavailable.push("Work Previous/Next unavailable: fewer than two navigable tasks");
  await measure(page, sample, "work.filter", async () => {
    const all = page.getByRole("group", { name: "Filter tasks by state" }).getByRole("button", { name: /^All/ });
    if (await keyboardReach(page, all, "Filter tasks by state", sample)) {
      await page.evaluate(() => performance.mark("looproom-activation"));
      await page.keyboard.press("ArrowRight");
    } else { await page.evaluate(() => performance.mark("looproom-activation")); await all.click(); }
  }, async () => { await page.locator('.work-filters button[data-value]:not([data-value="all"])[aria-pressed="true"]').waitFor(); });
  await page.getByRole("group", { name: "Filter tasks by state" }).getByRole("button", { name: /^All/ }).click();
  const taskWord = token(tasks[0].title);
  if (!taskWord) sample.unavailable.push("No usable actual task title search term");
  else await measure(page, sample, "work.search", async () => {
    const input = page.getByRole("searchbox", { name: "Search tasks" });
    if (!await keyboardReach(page, input, "Search tasks", sample)) await input.focus();
    await page.evaluate(() => performance.mark("looproom-activation"));
    await page.keyboard.press("Meta+A"); await page.keyboard.insertText(taskWord);
  }, async () => { await page.waitForFunction(term => { const rows = [...document.querySelectorAll('.work-record')]; return rows.length > 0 && rows.every(row => (row.textContent ?? '').toLowerCase().includes(String(term).toLowerCase())); }, taskWord); });
  await measure(page, sample, "review.open", () => activate(page, page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Review" }), "Review", sample), async () => { await page.getByRole("heading", { name: "Review", exact: true }).waitFor(); });
  if (!gates.length) sample.unavailable.push("Review gate unavailable");
  else {
    const alternateGate = page.locator('.review-queue button[aria-pressed="false"]').first();
    if (await alternateGate.count()) {
      const gateName = await alternateGate.locator('strong').first().innerText();
      await measure(page, sample, "review.context", () => activate(page, alternateGate, "Decision gate", sample), async () => {
        await page.waitForFunction(name => [...document.querySelectorAll('.review-queue button')].some(b => b.querySelector('strong')?.textContent?.trim() === name.trim() && b.getAttribute('aria-pressed') === 'true'), gateName);
        await page.getByLabel("Decision context").waitFor();
      });
    } else {
      // One gate is still a real Review workflow. Measure the native focus/read path, not a fabricated selection transition.
      await measure(page, sample, "review.context", () => keyboardReach(page, page.getByLabel("Decision context"), "Decision gate", sample).then(() => {}), async () => { await page.getByLabel("Decision context").waitFor(); });
    }
    const prGateIndex = gates.findIndex((gate: any) => gate.type === "pr");
    let selectedGateIndex = await page.locator('.review-queue button').evaluateAll(buttons => buttons.findIndex(b => b.getAttribute('aria-pressed') === 'true'));
    if (prGateIndex >= 0 && selectedGateIndex !== prGateIndex) {
      await activate(page, page.locator('.review-queue button').nth(prGateIndex), "PR gate", sample);
      await page.waitForFunction(index => document.querySelectorAll('.review-queue button')[index]?.getAttribute('aria-pressed') === 'true', prGateIndex, { timeout: 3000 });
      selectedGateIndex = prGateIndex;
    }
    const selectedGate = gates[selectedGateIndex] ?? gates[0];
    if (selectedGate.type === "pr") {
      const details = page.locator('.review-document .revision');
      try {
        await page.waitForFunction(() => !!document.querySelector('.review-document .revision') || !!document.querySelector('.review-document [role="alert"]'), null, { timeout: 5000 });
      } catch {
        sample.unavailable.push("Review PR details timed out");
      }
      if (await page.locator('.review-document [role="alert"]').count()) {
        sample.unavailable.push(`Review PR details load error: ${(await page.locator('.review-document [role="alert"]').first().innerText()).slice(0, 200)}`);
      } else if (await details.count()) {
        const diffTabs = page.locator('.review-diff-tabs');
        const summaryTab = diffTabs.getByRole("tab", { name: "Change summary" });
        const fullDiffTab = diffTabs.getByRole("tab", { name: "Full diff" });
        if (!await keyboardReach(page, summaryTab, "Change summary", sample)) sample.unavailable.push("Review diff tabs cannot be reached by native keyboard");
        else {
          try {
            await activateRovingTab(page, summaryTab, fullDiffTab, "Full diff", sample, "ArrowRight");
            await page.locator('.review-diff-tabs pre.diff').waitFor({ timeout: 3000 });
            const renderedDiff = (await page.locator('.review-diff-tabs pre.diff').innerText()).trim();
            if (!renderedDiff || renderedDiff === "No diff returned.") sample.unavailable.push("Review PR diff unavailable or empty");
          } catch (error) { sample.unavailable.push(`Review PR diff activation unavailable: ${errorText(error)}`); }
        }
        const merge = page.locator('.review-document .merge-button');
        if (await merge.count() === 1 && await merge.isEnabled()) {
          if (!await keyboardReach(page, merge, "Approve & merge", sample)) sample.unavailable.push("Review merge opener cannot be reached by native keyboard");
          else {
            await page.keyboard.press("Enter");
            const dialog = page.getByRole("dialog", { name: "Merge this revision?" });
            await dialog.waitFor({ timeout: 3000 });
            const dialogFocus = await focus(page);
            sample.keyboard.push({ checkpoint: "Merge dialog", focused: dialogFocus.focused, focusVisible: dialogFocus.visible, clipped: dialogFocus.clipped,
              reached: await dialog.evaluate(element => element.contains(document.activeElement)) });
            await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "hidden", timeout: 3000 });
            await recordFocus(page, merge, "Merge dialog return", sample);
          }
        } else sample.unavailable.push("Review merge confirmation unavailable for current PR state");
      }
    }
  }
  await measure(page, sample, "memory.open", () => activate(page, page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Memory" }), "Memory", sample), async () => { await page.getByRole("heading", { name: "Memory", exact: true }).waitFor(); });
  if (!memory.length) { sample.unavailable.push("Memory outcome unavailable"); return; }
  const alternateOutcome = page.locator('.memory-card[aria-pressed="false"]').first();
  if (await alternateOutcome.count()) {
    const outcomeName = await alternateOutcome.locator('strong').first().innerText();
    await measure(page, sample, "memory.outcome", () => activate(page, alternateOutcome, "Outcome", sample), async () => {
    await page.waitForFunction(name => [...document.querySelectorAll('.memory-card')].some(b => b.querySelector('strong')?.textContent?.trim() === name.trim() && b.getAttribute('aria-pressed') === 'true'), outcomeName);
    await page.getByRole("article", { name: "Selected memory" }).waitFor();
  });
  }
  else await measure(page, sample, "memory.outcome", () => keyboardReach(page, page.locator('.memory-card').first(), "Outcome", sample).then(() => {}), async () => { await page.getByRole("article", { name: "Selected memory" }).waitFor(); });
  const termPages = new Map<string, Set<string>>();
  for (const record of memory) for (const word of new Set((`${record.title ?? ""} ${record.content ?? ""}`.match(/[\p{L}\p{N}]{4,}/gu) ?? []).map(word => word.toLocaleLowerCase()))) {
    const pages = termPages.get(word) ?? new Set<string>(); pages.add(record.id); termPages.set(word, pages);
  }
  const distinctCitedTerms: { record: any; word: string; count: number }[] = memory.filter((m: any) => m.sources?.length).flatMap((record: any) =>
    [...new Set<string>((`${record.title ?? ""} ${record.content ?? ""}`.match(/[\p{L}\p{N}]{4,}/gu) ?? []).map(word => word.toLocaleLowerCase()))]
      .filter(word => (termPages.get(word)?.size ?? Infinity) <= 20)
      .map(word => ({ record, word, count: termPages.get(word)!.size })));
  distinctCitedTerms.sort((a, b) => a.count - b.count || b.word.length - a.word.length || a.word.localeCompare(b.word));
  const cited = distinctCitedTerms[0]?.record;
  const memoryWord = distinctCitedTerms[0]?.word;
  if (!cited || !memoryWord) sample.unavailable.push("Actual cited Memory outcome/search term unavailable");
  else {
    const input = page.getByRole("searchbox", { name: "Search project memory" });
    if (!await keyboardReach(page, input, "Search project memory", sample)) await input.focus();
    await page.keyboard.press("Meta+A"); await page.keyboard.insertText(memoryWord);
    const searchResponse = page.waitForResponse(response => response.url().includes(`/api/projects/${projectId}/memory?`) && response.request().method() === "GET");
    await measure(page, sample, "memory.search", async () => {
      await input.press("Enter");
      const response = await searchResponse;
      if (!response.ok() || !(await response.json() as any[]).some(page => page.id === cited.id)) sample.errors.push("Memory search did not return the cited actual outcome");
    }, async () => { await page.locator('.memory-search-field[aria-busy="false"]').waitFor(); await page.locator('.memory-shelf, .memory-search-error').first().waitFor(); });
    await measure(page, sample, "memory.clear", async () => { await input.focus(); await page.evaluate(() => performance.mark("looproom-activation")); await page.keyboard.press("Meta+A"); await page.keyboard.press("Backspace"); }, async () => { await page.waitForFunction(() => !!document.querySelector('.shelf-heading')?.textContent?.includes('Latest knowledge') && (document.querySelector('.memory-search-field input') as HTMLInputElement)?.value === ''); });
  }
  const libraryTab = page.getByRole("tab", { name: "Library" });
  const sourcesTab = page.getByRole("tab", { name: "Sources" });
  if (!await keyboardReach(page, libraryTab, "Library", sample)) throw new Error("Selected Library tab cannot be reached by native Tab");
  await measure(page, sample, "memory.sources", () => activateRovingTab(page, libraryTab, sourcesTab, "Sources", sample, "ArrowRight"), async () => { await page.locator(".source-atlas").waitFor(); });
  await restoreRovingTab(page, libraryTab);
}

// Capture public PR evidence through the coordinator's existing gh login.
// Pin both compare revisions; never expose the broker or merge methods to the viewer.
async function capturePrReview(binding: { gateId: string; projectId: string; pr: string; sha: string; base: string }) {
  const target = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(binding.pr);
  if (!target || !/^[a-f0-9]{40}$/.test(binding.sha)) throw new Error("PR snapshot binding invalid");
  const fields = "number,url,title,headRefOid,baseRefName,baseRefOid,statusCheckRollup,mergeable,state,body,files";
  const readInfo = async () => JSON.parse((await execFileAsync("gh", ["pr", "view", binding.pr, "--json", fields], { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout);
  const info = await readInfo();
  if (info.url !== binding.pr || info.number !== Number(target[3]) || info.headRefOid !== binding.sha || info.baseRefName !== binding.base || info.state !== "OPEN" || !/^[a-f0-9]{40}$/.test(info.baseRefOid ?? "") || !Array.isArray(info.files) || info.files.length > 300)
    throw new Error("PR snapshot revision, base or file scope differs from its gate");
  const compare = `repos/${target[1]}/${target[2]}/compare/${info.baseRefOid}...${binding.sha}`;
  const diff = (await execFileAsync("gh", ["api", "--method", "GET", compare, "--header", "Accept: application/vnd.github.diff"], { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout;
  const after = await readInfo();
  if (after.url !== info.url || after.headRefOid !== info.headRefOid || after.baseRefOid !== info.baseRefOid || after.baseRefName !== info.baseRefName || after.state !== "OPEN")
    throw new Error("PR changed while its frozen evidence was captured");
  if (!diff.trim()) throw new Error("PR snapshot diff unavailable");
  return { info, diff };
}

export async function runBrowserBaseline(options: { cwd: string; dataDir: string; projectId: string; databasePath: string; codexBinary: string; runId?: string; snapshotId?: string; timeoutMs?: number }): Promise<BrowserAuditReport> {
  const id = randomUUID(), cwd = await realpath(resolve(options.cwd)), dataDir = await realpath(resolve(options.dataDir)), base = join(dataDir, "browser-audit"), artifactDir = join(base, id), reportPath = join(base, `${id}.json`);
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const sourceHash = await sourceFingerprint(cwd);
  const sourceSha = await execFileAsync("/usr/bin/git", ["-C", cwd, "rev-parse", "HEAD"]).then(r => r.stdout.trim()).catch(() => null);
  const evaluatorHash = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
  const report: BrowserAuditReport = { id, kind: "browser-baseline", projectId: options.projectId, ...(options.runId ? { runId: options.runId } : {}), sourceHash, sourceSha, sourceUnchanged: false, buildHash: null, snapshotId: null, snapshotHash: null, protocolHash: BROWSER_PROTOCOL_HASH, evaluatorHash, createdAt: new Date().toISOString(), reportPath, measurementDurationMs: null, status: "unavailable", unavailable: [], environment: { browserChannel: "chrome", headless: true, transport: "refusing loopback HTTP proxy; no DIRECT fallback", captureMode: "consistent read-only projection; source coordinator can keep writing", osVersion: osVersion(), processor: cpus()[0]?.model ?? null, memoryBytes: totalmem(), deviceScaleFactor: 1, protocol: CONTRACT }, observations: { samples: [], aggregates: {} }, artifacts: [], artifactHashes: {} };
  let measurementStartedAt: number | undefined, budgetTimer: NodeJS.Timeout | undefined;
  let viewer: { url: string; close: () => Promise<void> | void } | undefined, browser: Browser | undefined;
  try {
    const snapshotDir = join(dataDir, "browser-snapshots");
    const snapshot = options.snapshotId
      ? await loadBrowserSnapshot(snapshotDir, options.snapshotId, options.projectId)
      : await captureBrowserSnapshot({ databasePath: options.databasePath, projectId: options.projectId, directory: snapshotDir, capturePrReview });
    report.snapshotId = snapshot.id; report.snapshotHash = snapshot.hash;
    const reviewGates = snapshot.state.gates.filter((g: any) => needsHumanReview(g, snapshot.state.projects[0]));
    report.environment.reviewGateType = reviewGates.some((g: any) => g.type === "pr") ? "pr" : reviewGates.length ? "non-pr" : "none";
    report.environment.snapshotCapturedAt = snapshot.capturedAt; report.environment.counts = snapshot.counts; report.environment.eventSequence = snapshot.eventSequence;
    report.environment.macProductVersion = await execFileAsync("/usr/bin/sw_vers", ["-productVersion"]).then(r => r.stdout.trim()).catch(() => null);
    report.environment.packageLockHash = createHash("sha256").update(await readFile(join(cwd, "package-lock.json"))).digest("hex");
    const coordinatorRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    report.environment.coordinatorSourceSha = await execFileAsync("/usr/bin/git", ["-C", coordinatorRepo, "rev-parse", "HEAD"]).then(r => r.stdout.trim()).catch(() => null);
    const verification = await runVerification({ cwd, commands: ["npm run build"], dataDir, codexBinary: options.codexBinary, buildArtifactDir: join(artifactDir, "dist") });
    if (!verification.sourceUnchanged || verification.sourceHash !== sourceHash || verification.results.length !== 1 || verification.results[0].code !== 0 || !verification.buildArtifact) throw new Error("Isolated audited-source build unavailable or failed");
    report.buildHash = verification.buildArtifact.hash;
    report.environment.buildReportId = verification.id;
    viewer = await startBrowserViewer({ snapshot, distDir: verification.buildArtifact.directory });
    const packageJson = JSON.parse(await readFile(createRequire(import.meta.url).resolve("playwright-core/package.json"), "utf8"));
    report.environment.playwrightVersion = packageJson.version;
    // A refusing loopback proxy preserves Chrome's real HTTP cache. Playwright
    // HTTP routing disables cache, so it cannot implement the frozen protocol.
    const viewerOrigin = new URL(viewer.url).origin;
    browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 15_000,
      args: ["--disable-background-networking", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", `--proxy-server=${viewerOrigin}`, "--proxy-bypass-list=<-loopback>"] });
    report.environment.browserVersion = browser.version();
    const context = await browser.newContext({ viewport: VIEWPORTS[0], deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: "block" });
    await context.routeWebSocket("**/*", socket => { report.unavailable.push("Blocked WebSocket request"); socket.close(); });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const measurementStart = Date.now(), budget = Math.max(1, Math.min(options.timeoutMs ?? CONTRACT.budgetMs, CONTRACT.budgetMs)), deadline = measurementStart + budget;
    measurementStartedAt = measurementStart;
    budgetTimer = setTimeout(() => {
      report.unavailable.push("Browser measurement exceeded its fixed budget");
      void context.close().catch(() => {});
    }, budget);
    budgetTimer.unref();
    for (const [vi, viewport] of VIEWPORTS.entries()) {
      for (let repetition = 0; repetition <= 5; repetition++) {
        if (Date.now() >= deadline) throw new Error("Browser measurement exceeded 30-minute budget");
        const page = await context.newPage(); await page.setViewportSize(viewport); page.setDefaultTimeout(Math.min(5000, Math.max(1000, deadline - Date.now())));
        const sample: BrowserSample = { viewport: vi ? "mobile" : "desktop", repetition, warmup: repetition === 0, operations: [], navigation: { domContentLoadedMs: null, transferBytes: null, resourceBytes: null, cachedAssetCount: null }, keyboard: [], errors: [], unavailable: [] };
        page.on("pageerror", e => sample.errors.push(`Page error: ${e.message}`));
        page.on("requestfailed", request => sample.errors.push(`Request failed: ${request.method()} ${new URL(request.url()).pathname}`));
        page.on("console", message => { if (message.type() === "error") sample.errors.push(`Console: ${message.text().slice(0, 300)}`); });
        try { await runBrowserSample(page, sample, snapshot, viewer.url); }
        catch (e) { sample.unavailable.push(`Protocol stopped: ${errorText(e)}`); }
        const screenshot = join(artifactDir, `${sample.viewport}-${repetition}.png`);
        await page.screenshot({ path: screenshot, fullPage: false }).then(() => { sample.screenshot = screenshot; report.artifacts.push(screenshot); }).catch(e => sample.unavailable.push(`Screenshot unavailable: ${errorText(e)}`));
        report.observations.samples.push(sample);
        await page.close();
      }
    }
    report.measurementDurationMs = Date.now() - measurementStart;
    const trace = join(artifactDir, "trace.zip"); await context.tracing.stop({ path: trace }); report.artifacts.push(trace); await context.close();
    for (const viewport of ["desktop", "mobile"] as const) for (const name of REQUIRED) {
      const ops = report.observations.samples.filter(s => s.viewport === viewport && !s.warmup).map(s => s.operations.find(o => o.name === name));
      if (ops.length === 5 && ops.every(Boolean)) {
        const rawMs = ops.map(o => o!.durationMs);
        report.observations.aggregates[`${viewport}.${name}`] = { rawMs, p75Ms: percentile(rawMs, .75), medianMs: percentile(rawMs, .5), maximumLongTaskMs: ops.some(o => o!.maxLongTaskMs === null) ? null : Math.max(...ops.map(o => o!.maxLongTaskMs!)) };
      }
    }
  } catch (e) { report.unavailable.push(errorText(e)); }
  finally {
    if (budgetTimer) clearTimeout(budgetTimer);
    if (measurementStartedAt !== undefined) report.measurementDurationMs = Date.now() - measurementStartedAt;
    await browser?.close().catch(() => {});
    await viewer?.close();
    report.sourceUnchanged = sourceHash === await sourceFingerprint(cwd).catch(() => "");
    const evaluatorAfter = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
    if (evaluatorAfter !== evaluatorHash) report.unavailable.push("Evaluator source changed during measurement");
    for (const artifact of report.artifacts) report.artifactHashes[artifact] = await readFile(artifact).then(b => createHash("sha256").update(b).digest("hex")).catch(() => "");
    report.unavailable.push(...validateBrowserReport(report));
    report.unavailable = [...new Set(report.unavailable)];
    report.status = report.unavailable.length ? "unavailable" : "complete";
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  return report;
}
