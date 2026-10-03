import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Engine, Plan, Result, Judgment } from "./engine.ts";
import { Store } from "./store.ts";
import { testFixture } from "./test-fixtures.ts";
import type { Runtime } from "./runtime.ts";
import { normalizeModelOutput, strictModelOutputSchema } from "./model-output.ts";

function assertStrictObjects(node: any): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "object" || node.properties) {
    assert.equal(node.additionalProperties, false);
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties ?? {}).sort());
  }
  for (const child of Object.values(node.properties ?? {})) assertStrictObjects(child);
  for (const child of Object.values(node.$defs ?? {})) assertStrictObjects(child);
  if (node.items) assertStrictObjects(node.items);
  for (const key of ["anyOf", "oneOf", "allOf"])
    for (const child of node[key] ?? []) assertStrictObjects(child);
}

test("Plan, Result and Judgment model schemas require every key and accept nullable optionals", () => {
  for (const schema of [Plan, Result, Judgment]) {
    const strict = strictModelOutputSchema(z.toJSONSchema(schema));
    assertStrictObjects(strict);
    assert.equal(JSON.stringify(strict).includes('"default"'), false);
    assert.equal(JSON.stringify(strict).includes('"propertyNames"'), false);
  }
  const planOriginal = z.toJSONSchema(Plan);
  const plan = Plan.parse(normalizeModelOutput({ summary: "Plan", gate: "", sources: [], claims: null,
    tasks: [{ title: "Research", description: "Inspect", acceptance: [], dependencies: [],
      kind: "research", experiment: null }] }, planOriginal));
  assert.deepEqual(plan.claims, []);
  assert.equal(plan.tasks[0].experiment, undefined);

  const resultOriginal = z.toJSONSchema(Result);
  const result = Result.parse(normalizeModelOutput({ summary: "Done", sources: [], humanQuestion: "",
    repairWait: null, claims: null, experimentCandidate: null }, resultOriginal));
  assert.deepEqual(result.claims, []);
  assert.equal(result.repairWait, undefined);
  assert.equal(result.experimentCandidate, undefined);

  const judgmentOriginal = z.toJSONSchema(Judgment);
  const judgment = Judgment.parse(normalizeModelOutput({ action: "wait", answer: "Evidence pending",
    summary: "Wait", sources: [], nextRound: null, verificationRequests: null }, judgmentOriginal));
  assert.equal(judgment.nextRound, undefined);
  assert.deepEqual(judgment.verificationRequests, []);
  assert.throws(() => Judgment.parse(normalizeModelOutput({ action: "retry", answer: "Try",
    summary: "Bad", sources: [], verificationRequests: [], nextRound: {
      hypothesis: "Cache", retryInstruction: "Measure", contract: null,
    } }, judgmentOriginal)), /contract/);
  assert.throws(() => Plan.parse(normalizeModelOutput({ summary: "Bad", gate: "", sources: [],
    claims: null, tasks: null }, planOriginal)), /tasks/);
});

test("normalization follows nested array items and local references without stripping required nulls", () => {
  const original = { type: "object", properties: { items: { type: "array",
    items: { $ref: "#/$defs/item" } } }, required: ["items"], $defs: {
    item: { type: "object", properties: { value: { type: "string" }, note: { type: "string" } },
      required: ["value"] },
  } };
  const strict = strictModelOutputSchema(original);
  assertStrictObjects(strict);
  assert.deepEqual(normalizeModelOutput({ items: [{ value: "kept", note: null },
    { value: null, note: null }] }, original),
    { items: [{ value: "kept" }, { value: null }] });

  const node: z.ZodTypeAny = z.lazy(() => z.object({ value: z.string(),
    note: z.string().optional(), children: z.array(node).optional() }));
  const zodOriginal = z.toJSONSchema(node);
  assert.equal((zodOriginal as any).properties.children.items.$ref, "#");
  const nativeStyle = { value: "root", note: null,
    children: [{ value: "child", note: null, children: null }] };
  assert.deepEqual(node.parse(normalizeModelOutput(nativeStyle, zodOriginal)),
    { value: "root", children: [{ value: "child" }] });
});

test("Engine.run accepts native nullable optionals for actual Plan, Result and Judgment outputs", async () => {
  const dir = await testFixture("looproom-model-output-");
  const store = new Store(join(dir, "db"));
  const outputs = [
    { summary: "Plan", gate: "", sources: [], claims: null,
      tasks: [{ title: "Research", description: "Inspect", acceptance: [], dependencies: [],
        kind: "research", experiment: null }] },
    { summary: "Done", sources: [], humanQuestion: "", repairWait: null,
      claims: null, experimentCandidate: null },
    { action: "wait", answer: "Evidence pending", summary: "Wait", sources: [],
      nextRound: null, verificationRequests: null },
  ];
  const schemas: any[] = [];
  const runtime = Object.assign(new EventEmitter(), { close() {}, async run(options: any) {
    schemas.push(options.schema);
    return JSON.stringify(outputs.shift());
  } }) as Runtime;
  const engine = new Engine(store, runtime, dir);
  try {
    store.put("settings", { orchestrator: { model: "gpt-6.1-sol", effort: "high" },
      subagent: { model: "gpt-6-sol", effort: "medium" } }, "settings");
    const project = store.put("project", { path: dir, status: "running", goal: "Fixture", constraints: "" });
    const plan = await engine.run(project, "orchestrator", "Plan", Plan);
    const result = await engine.run(project, "research", "Research", Result);
    const judgment = await engine.run(project, "judge", "Judge", Judgment);
    assert.deepEqual(plan.claims, []);
    assert.equal(plan.tasks[0].experiment, undefined);
    assert.deepEqual(result.claims, []);
    assert.equal(result.repairWait, undefined);
    assert.equal(result.experimentCandidate, undefined);
    assert.equal(judgment.nextRound, undefined);
    assert.deepEqual(judgment.verificationRequests, []);
    assert.equal(schemas.length, 3);
    for (const schema of schemas) assertStrictObjects(schema);
    assert.equal(store.all("run").filter(run => run.status === "completed").length, 3);
  } finally { engine.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
