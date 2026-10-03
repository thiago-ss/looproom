import { Store } from "./store.ts";

export type ExperimentContract = {
  evaluator: string;
  workload: string;
  runtimeBudget: string;
  thresholds: Record<string, string | number>;
  candidateLimit: number;
};

function sameContract(a: ExperimentContract, b: ExperimentContract) {
  const fields = (value: ExperimentContract) => JSON.stringify({
    evaluator: value.evaluator, workload: value.workload,
    runtimeBudget: value.runtimeBudget, candidateLimit: value.candidateLimit,
    thresholds: Object.entries(value.thresholds).sort(([a], [b]) => a.localeCompare(b)),
  });
  return fields(a) === fields(b);
}

const refreshCommand = "node --import tsx scripts/measure-refresh.ts";
const refreshWorkload = "4 paused projects, 48 completed tasks, 80 events, 5 message updates";
const metricNames = ["baselineRefreshBytes", "baselineCoordinatorRoundTripMs", "baselineUpdateLatencyMs"] as const;

// Only the refresh recipe has defined machine comparison semantics. Evidence
// comes from coordinator verification records, never from worker prose.
function keepDecision(store: Store, round: any, candidate: any): string | undefined {
  const contract = round.contract as ExperimentContract;
  const project = store.get(round.projectId, "project");
  const baseline = project.refreshBaseline;
  const expected = { minMedianImprovementPercent: 10, maxOtherMedianRegressionPercent: 5,
    requiredChecks: "npm test" };
  const sorted = (value: Record<string, string | number>) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  if (sorted(contract.thresholds) !== sorted(expected) ||
      contract.workload !== refreshWorkload || contract.runtimeBudget !== "30 seconds" ||
      !baseline || baseline.phase !== "frozen" ||
      contract.evaluator !== `scripts/measure-refresh.ts#sha256:${baseline.evaluatorHash}`)
    return "Frozen experiment thresholds or refresh evaluator identity cannot be evaluated.";
  const ids = candidate.evidence.filter((source: string) => /^verification:[a-f0-9-]{36}$/.test(source))
    .map((source: string) => source.slice("verification:".length));
  const report = ids.map((id: string) => store.all("verification-report", round.projectId)
    .find((record) => record.report.id === id)?.report).find((item: any) => item?.runId === candidate.runId);
  const baselineReport = store.all("verification-report", round.projectId)
    .find((record) => record.report.id === baseline.reportId)?.report;
  const baselineSourceHash = baseline.measurementSourceHash ??
    store.all("task", round.projectId).find((task) => task.id === baseline.ownerTaskId)
      ?.baselineVerification?.sourceHash;
  if (!report || !baselineReport || report.id === baselineReport.id ||
      report.evaluatorHash !== baseline.evaluatorHash || baselineReport.evaluatorHash !== baseline.evaluatorHash ||
      !report.sourceUnchanged || !baselineReport.sourceUnchanged ||
      !baselineSourceHash || baselineReport.sourceHash !== baselineSourceHash)
    return "Matching coordinator candidate and frozen baseline evaluator reports are missing.";
  const parse = (value: any) => {
    const result = value.results?.find((entry: any) => entry.command === refreshCommand &&
      entry.code === 0 && !entry.timedOut && entry.durationMs <= 30_000);
    if (!result) return undefined;
    try {
      const parsed = JSON.parse(result.output);
      if (parsed.workload !== refreshWorkload || parsed.repetitions !== 5 ||
          !metricNames.every((name) => typeof parsed[name] === "number" &&
            Number.isFinite(parsed[name]) && parsed[name] > 0)) return undefined;
      return parsed;
    } catch { return undefined; }
  };
  const base = parse(baselineReport), measured = parse(report);
  if (!base || !measured) return "Exact evaluator output or comparable numeric medians are missing.";
  if (!report.results.length || report.results.some((entry: any) => entry.code !== 0 || entry.timedOut) ||
      !report.results.some((entry: any) => entry.command === "npm test" && entry.code === 0 && !entry.timedOut))
    return "Required test and native sandbox checks did not pass in the candidate report.";
  const changes = metricNames.map((name) => (measured[name] - base[name]) / base[name] * 100);
  if (!changes.some((change) => change <= -10))
    return "No refresh median improved by the frozen 10% threshold.";
  if (changes.some((change) => change > 5))
    return "A refresh median regressed beyond the frozen 5% limit.";
  return undefined;
}

function gateRejectedKeep(store: Store, round: any, reason: string) {
  const exhausted = store.get(round.id, "experiment-round").status === "exhausted";
  store.patch(round.taskId, { status: exhausted ? "blocked" : "ready", feedback: reason });
  if (!exhausted) return;
  const gate = store.put("gate", { projectId: round.projectId, taskId: round.taskId,
    type: "experiment", status: "open", title: "Experiment keep rejected",
    detail: reason, experimentRoundId: round.id, authorRole: "coordinator",
    createdAt: new Date().toISOString() });
  store.recordEscalation(gate);
}

export function validateExperimentContract(contract: ExperimentContract) {
  if (!contract.evaluator.trim() || !contract.workload.trim() ||
      !contract.runtimeBudget.trim() || !Object.keys(contract.thresholds).length ||
      !Number.isInteger(contract.candidateLimit) || contract.candidateLimit < 1 ||
      contract.candidateLimit > 3)
    throw new Error("Experiment requires a fixed evaluator, workload, runtime budget, thresholds and at most three candidates.");
}

export function startExperiment(store: Store, projectId: string, taskId: string,
  hypothesis: string, contract: ExperimentContract, inTransaction = false) {
  validateExperimentContract(contract);
  if (!hypothesis.trim()) throw new Error("Experiment hypothesis is required.");
  const create = () => {
    const task = store.get(taskId, "task");
    if (task.projectId !== projectId || task.experimentRoundId)
      throw new Error("Experiment task is invalid or already has a round.");
    const round = store.put("experiment-round", {
      projectId, taskId, number: 1, hypothesis, contract,
      candidateIds: [], status: "active", createdAt: new Date().toISOString(),
    });
    store.patch(taskId, { experimentRoundId: round.id });
    return round;
  };
  return inTransaction ? create() : store.transaction(create);
}

export function recordCandidate(store: Store, roundId: string, input: {
  runId: string; outcome: "keep" | "discard"; measurement: string;
  evidence: string[]; evaluator: string; workload: string;
  runtimeBudget: string; thresholds: Record<string, string | number>;
  reportedOutcome?: "keep" | "discard"; rejection?: string;
}) {
  return store.transaction(() => {
    const round = store.get(roundId, "experiment-round");
    const run = store.get(input.runId, "run");
    if (round.status !== "active" || run.projectId !== round.projectId ||
        run.taskId !== round.taskId || run.role !== "implementation" ||
        run.experimentRoundId !== round.id)
      throw new Error("Candidate does not belong to the active experiment round.");
    const contract = round.contract as ExperimentContract;
    if (!sameContract(contract, { evaluator: input.evaluator, workload: input.workload,
      runtimeBudget: input.runtimeBudget, thresholds: input.thresholds,
      candidateLimit: contract.candidateLimit }))
      throw new Error("Candidate evaluator, workload, budget or thresholds differ from the frozen round contract.");
    if (!input.measurement.trim() || !input.evidence.length || input.evidence.some((s) => !s.trim()))
      throw new Error("Candidate needs a measurement and source evidence.");
    const existing = store.all("experiment-candidate", round.projectId).find((c) => c.runId === run.id);
    if (existing) throw new Error("Implementation run already has a candidate outcome.");
    if (round.candidateIds.length >= contract.candidateLimit || round.candidateIds.length >= 3)
      throw new Error("Experiment round candidate limit is exhausted.");
    const proposed = { ...input, projectId: round.projectId, taskId: round.taskId, roundId };
    const rejection = input.outcome === "keep" ? keepDecision(store, round, proposed) : undefined;
    const outcome = rejection ? "discard" : input.outcome;
    const candidate = store.put("experiment-candidate", {
      ...proposed, outcome, reportedOutcome: input.outcome,
      rejection: rejection ?? input.rejection,
      number: round.candidateIds.length + 1, createdAt: new Date().toISOString(),
    });
    const candidateIds = [...round.candidateIds, candidate.id];
    store.patch(round.id, { candidateIds,
      status: outcome === "keep" ? "kept" :
        candidateIds.length === contract.candidateLimit ? "exhausted" : "active" });
    if (rejection) gateRejectedKeep(store, round, rejection);
    return candidate;
  });
}

// A slot belongs to an implementation run before the worker is dispatched. The
// round limit therefore also covers runs that return through a decision gate.
export function reserveCandidate(store: Store, roundId: string, runId: string) {
  const round = store.get(roundId, "experiment-round");
  const run = store.get(runId, "run");
  if (round.status !== "active" || run.role !== "implementation" ||
      run.projectId !== round.projectId || run.taskId !== round.taskId ||
      run.experimentRoundId !== round.id)
    throw new Error("Run does not belong to the active experiment round.");
  if (round.candidateIds.length >= Math.min(3, round.contract.candidateLimit))
    throw new Error("Experiment round candidate limit is exhausted.");
  if (round.candidateIds.some((id: string) =>
    ["reserved", "measured"].includes(store.get(id).status)))
    throw new Error("An experiment candidate is already pending reconciliation.");
  const candidate = store.put("experiment-candidate", {
    projectId: round.projectId, taskId: round.taskId, roundId, runId,
    number: round.candidateIds.length + 1, status: "reserved",
    createdAt: new Date().toISOString(),
  });
  store.patch(round.id, { candidateIds: [...round.candidateIds, candidate.id] });
  return candidate;
}

export function reportCandidate(store: Store, candidateId: string, input: {
  outcome: "keep" | "discard"; measurement: string; evidence: string[];
  evaluator: string; workload: string; runtimeBudget: string;
  thresholds: Record<string, string | number>;
}) {
  const candidate = store.get(candidateId, "experiment-candidate");
  const round = store.get(candidate.roundId, "experiment-round");
  if (candidate.status !== "reserved") throw new Error("Candidate measurement was already attached.");
  if (!sameContract(round.contract, { ...input, candidateLimit: round.contract.candidateLimit }))
    throw new Error("Candidate evaluator, workload, budget or thresholds differ from the frozen round contract.");
  if (!input.measurement.trim() || !input.evidence.length || input.evidence.some((s) => !s.trim()))
    throw new Error("Candidate needs a measurement and source evidence.");
  return store.patch(candidate.id, { ...input, reportedOutcome: input.outcome, status: "measured" });
}

export function finalizeCandidate(store: Store, candidateId: string,
  outcome: "keep" | "discard", rejection?: string, evidence: string[] = []) {
  return store.transaction(() => {
    const candidate = store.get(candidateId, "experiment-candidate");
    if (candidate.status !== "measured") throw new Error("Candidate is not pending finalization.");
    if (outcome === "keep" && candidate.reportedOutcome !== "keep")
      throw new Error("A reported discard cannot be relabeled kept.");
    const round = store.get(candidate.roundId, "experiment-round");
    if (round.status !== "active") throw new Error("Experiment round is not active.");
    const allEvidence = [...new Set([...candidate.evidence, ...evidence])];
    const keepRejection = outcome === "keep" ?
      keepDecision(store, round, { ...candidate, evidence: allEvidence }) : undefined;
    const actualOutcome = keepRejection ? "discard" : outcome;
    const finalized = store.patch(candidate.id, { status: "finalized", outcome: actualOutcome,
      rejection: keepRejection ?? rejection, evidence: allEvidence,
      finalizedAt: new Date().toISOString() });
    if (actualOutcome === "keep" || round.candidateIds.length >= round.contract.candidateLimit)
      store.patch(round.id, { status: actualOutcome === "keep" ? "kept" : "exhausted" });
    if (keepRejection) gateRejectedKeep(store, round, keepRejection);
    return finalized;
  });
}

export function abandonUnmeasuredCandidate(store: Store, candidateId: string, reason: string) {
  return store.transaction(() => {
    const candidate = store.get(candidateId, "experiment-candidate");
    if (candidate.status !== "reserved") throw new Error("Candidate slot is not awaiting a measurement.");
    const round = store.get(candidate.roundId, "experiment-round");
    if (round.status !== "active") throw new Error("Experiment round is not active.");
    const abandoned = store.patch(candidate.id, { status: "unmeasured", rejection: reason,
      finalizedAt: new Date().toISOString() });
    if (round.candidateIds.length >= round.contract.candidateLimit)
      store.patch(round.id, { status: "exhausted" });
    return abandoned;
  });
}

export function authorizeNextRound(store: Store, roundId: string, judgeRunId: string,
  hypothesis: string, retryInstruction: string, contract: ExperimentContract,
  inTransaction = false) {
  validateExperimentContract(contract);
  if (!hypothesis.trim() || !retryInstruction.trim())
    throw new Error("Next round needs a concrete hypothesis and retry instruction.");
  const create = () => {
    const prior = store.get(roundId, "experiment-round");
    const judge = store.get(judgeRunId, "run");
    if (judge.role !== "judge" || judge.projectId !== prior.projectId ||
        judge.taskId !== prior.taskId || prior.status !== "exhausted" || prior.nextRoundId)
      throw new Error("Only one judge-authorized next round may follow an exhausted round.");
    if (!sameContract(prior.contract, contract))
      throw new Error("Next round must preserve evaluator, workload, runtime budget and thresholds.");
    const normalize = (value: string) => value.normalize("NFKC").toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
    if (normalize(hypothesis) === normalize(prior.hypothesis))
      throw new Error("Next round needs a hypothesis distinct from the exhausted round.");
    const instruction = normalize(retryInstruction);
    const words = instruction.split(" ");
    const changeWords = instruction.split(/\b(?:measure|benchmark|compare|evaluate|test|verify)\b/, 1)[0]
      .split(" ").filter((word) => word && !/^(implement|change|changes|replace|remove|add|cache|caching|batch|reduce|avoid|use|optimize|refactor|try|again|and|the|a|an|with|only|code|it)$/.test(word));
    const measurementReference = [contract.workload, contract.evaluator,
      ...Object.keys(contract.thresholds)].some((value) => instruction.includes(normalize(value)));
    if (words.length < 6 || changeWords.length < 2 ||
        !/\b(measure|benchmark|compare|evaluate|test|verify)\b/.test(instruction) ||
        !/\b(implement|change|replace|remove|add|cache|caching|batch|reduce|avoid|use|optimize|refactor)\b/.test(instruction) ||
        !measurementReference)
      throw new Error("Next round needs a specific change and how it will be measured.");
    const task = store.get(prior.taskId, "task");
    if (task.experimentRoundId !== prior.id)
      throw new Error("Originating task no longer owns this round.");
    const round = store.put("experiment-round", {
      projectId: prior.projectId, taskId: prior.taskId,
      number: prior.number + 1, previousRoundId: prior.id, judgeRunId,
      hypothesis, contract, retryInstruction, candidateIds: [],
      status: "active", createdAt: new Date().toISOString(),
    });
    store.patch(prior.id, { nextRoundId: round.id });
    store.patch(task.id, { experimentRoundId: round.id,
      attempt: 0, judgeRetries: 0,
      feedback: `Judge authorized experiment round ${round.number}: ${retryInstruction}` });
    return round;
  };
  return inTransaction ? create() : store.transaction(create);
}
