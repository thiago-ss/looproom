import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_PROTOCOL_HASH, compareBrowserReports, percentile, validateBrowserReport, type BrowserAuditReport, type BrowserSample } from "./browser-audit.ts";

const names = ["goal.load", "goal.scroll", "goal.latest", "goal.context", "work.open", "work.connections", "work.task", "work.navigation", "work.filter", "work.search", "review.open", "review.context", "memory.open", "memory.outcome", "memory.search", "memory.clear", "memory.sources"];
const checkpoints = ["Goal conversation", "Latest messages", "Context", "Context return", "Work", "Connections", "Workstream", "Inspect task", "Next task", "Previous task", "Filter tasks by state", "Search tasks", "Review", "Decision gate", "Memory", "Outcome", "Search project memory", "Sources", "Library"];
function fixture(value = 200): BrowserAuditReport {
  const samples: BrowserSample[] = [];
  const aggregates: BrowserAuditReport["observations"]["aggregates"] = {};
  for (const viewport of ["desktop", "mobile"] as const) {
    for (let repetition = 0; repetition <= 5; repetition++) samples.push({ viewport, repetition, warmup: repetition === 0,
      screenshot: `/fixture/${viewport}-${repetition}.png`, operations: names.map(name => ({ name, durationMs: value, maxLongTaskMs: 0, focus: "button", focusVisible: true, focusClipped: false, horizontalOverflow: false })),
      navigation: { domContentLoadedMs: 100, transferBytes: 1000, resourceBytes: 4000, cachedAssetCount: repetition === 0 ? 0 : 1 }, keyboard: checkpoints.map(checkpoint => ({ checkpoint, focused: checkpoint, focusVisible: true, clipped: false, reached: true })), errors: [], unavailable: [] });
    for (const name of names) aggregates[`${viewport}.${name}`] = { rawMs: Array(5).fill(value), p75Ms: value, medianMs: value, maximumLongTaskMs: 0 };
  }
  return { id: "11111111-1111-1111-1111-111111111111", kind: "browser-baseline", projectId: "22222222-2222-2222-2222-222222222222", sourceHash: "a".repeat(64), sourceSha: "a".repeat(40), sourceUnchanged: true,
    buildHash: "b".repeat(64), snapshotId: "33333333-3333-3333-3333-333333333333", snapshotHash: "c".repeat(64), protocolHash: BROWSER_PROTOCOL_HASH, evaluatorHash: "a".repeat(64),
    createdAt: "2026-10-03T00:00:00Z", reportPath: "/fixture", measurementDurationMs: 1000, status: "complete", unavailable: [],
    environment: { reviewGateType: "non-pr", browserVersion: "fixture", playwrightVersion: "fixture", osVersion: "fixture", macProductVersion: "fixture", packageLockHash: "d".repeat(64), buildReportId: "44444444-4444-4444-4444-444444444444", processor: "fixture", memoryBytes: 1, deviceScaleFactor: 1 },
    observations: { samples, aggregates }, artifacts: ["/fixture/trace.zip", ...samples.map(s => s.screenshot!)], artifactHashes: Object.fromEntries(samples.map(s => [s.screenshot!, "a".repeat(64)]).concat([["/fixture/trace.zip", "a".repeat(64)]])) };
}
test("browser report validates raw five repetitions and exact aggregates", () => {
  const report = fixture();
  assert.deepEqual(validateBrowserReport(report), []);
  report.observations.aggregates["desktop.goal.load"].p75Ms = 1;
  assert.match(validateBrowserReport(report).join(" "), /invalid aggregate/);
  report.observations.aggregates["desktop.goal.load"].p75Ms = 200;
  report.observations.samples[1].operations = report.observations.samples[1].operations.filter(o => o.name !== "goal.load");
  assert.match(validateBrowserReport(report).join(" "), /goal.load missing/);
});
test("measured focus defects remain complete but new failures discard candidate", () => {
  const baseline = fixture(), candidate = fixture(140);
  for (const sample of candidate.observations.samples) sample.keyboard[0].reached = false;
  assert.deepEqual(validateBrowserReport(candidate), []);
  assert.equal(compareBrowserReports(baseline, candidate, "goal.load").decision, "discard");
  for (const sample of baseline.observations.samples) sample.keyboard[0].reached = false;
  assert.equal(compareBrowserReports(baseline, candidate, "goal.load").decision, "keep");
});
test("candidate comparison refuses changed snapshot or missing metric, and applies both thresholds", () => {
  const baseline = fixture(), candidate = fixture(180);
  assert.equal(compareBrowserReports(baseline, candidate, "goal.load").decision, "discard");
  for (const viewport of ["desktop", "mobile"]) {
    const a = candidate.observations.aggregates[`${viewport}.goal.load`];
    a.rawMs = [130, 130, 130, 130, 130]; a.p75Ms = 130; a.medianMs = 130;
    for (const sample of candidate.observations.samples.filter(s => s.viewport === viewport)) sample.operations.find(o => o.name === "goal.load")!.durationMs = 130;
  }
  assert.equal(compareBrowserReports(baseline, candidate, "goal.load").decision, "keep");
  candidate.snapshotHash = "changed";
  assert.equal(compareBrowserReports(baseline, candidate, "goal.load").decision, "unavailable");
  candidate.snapshotHash = baseline.snapshotHash;
  candidate.observations.samples.pop();
  assert.equal(compareBrowserReports(baseline, candidate, "goal.load").decision, "unavailable");
  assert.equal(percentile([1, 2, 3, 4, 5], .75), 4);
});


test("malformed and partial observations cannot pass or throw during validation", () => {
  for (const corrupt of [
    (r: BrowserAuditReport) => { r.observations.aggregates["desktop.goal.load"].rawMs[0] = NaN; },
    (r: BrowserAuditReport) => { r.observations.samples[0].operations[0].durationMs = -1; },
    (r: BrowserAuditReport) => { r.observations.samples[0].navigation.resourceBytes = NaN; },
    (r: BrowserAuditReport) => { r.observations.samples[0].operations.push(r.observations.samples[0].operations[0]); },
    (r: BrowserAuditReport) => { r.observations.samples[0].keyboard.push(r.observations.samples[0].keyboard[0]); },
    (r: BrowserAuditReport) => { r.observations.samples[1].navigation.cachedAssetCount = 0; },
    (r: BrowserAuditReport) => { r.artifactHashes["/fixture/trace.zip"] = ""; },
    (r: BrowserAuditReport) => { r.measurementDurationMs = Infinity; },
  ]) {
    const report = fixture(); corrupt(report);
    assert.ok(validateBrowserReport(report).length);
    assert.equal(compareBrowserReports(fixture(), report, "goal.load").decision, "unavailable");
  }
  const baseline = fixture(), candidate = fixture(130);
  candidate.status = "unavailable";
  assert.equal(compareBrowserReports(baseline, candidate, "goal.load").decision, "unavailable");
  candidate.status = "complete"; candidate.unavailable.push("missing proof");
  assert.equal(compareBrowserReports(baseline, candidate, "goal.load").decision, "unavailable");
});


test("PR case requires native diff and canceled merge dialog evidence", () => {
  const r=fixture(); r.environment.reviewGateType="pr";
  assert.match(validateBrowserReport(r).join(" "), /Merge dialog keyboard checkpoint missing/);
  for (const s of r.observations.samples) for (const checkpoint of ["Change summary", "Full diff", "Approve & merge", "Merge dialog", "Merge dialog return"]) s.keyboard.push({checkpoint,focused:checkpoint,focusVisible:true,clipped:false,reached:true});
  assert.deepEqual(validateBrowserReport(r),[]);
});
