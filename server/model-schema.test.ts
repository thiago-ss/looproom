import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Engine } from "./engine.ts";
import { Store } from "./store.ts";
import { testFixture } from "./test-fixtures.ts";
import type { Runtime } from "./runtime.ts";

test("actual judge output schema has explicit frozen refresh thresholds and no unsupported propertyNames", async () => {
  const dir = await testFixture("looproom-model-schema-");
  const store = new Store(join(dir, "db"));
  let schema: any;
  const runtime = Object.assign(new EventEmitter(), { close() {}, async run(options: any) {
    schema = options.schema;
    return JSON.stringify({ action: "wait", answer: "Wait for evidence", summary: "Evidence pending",
      sources: [], verificationRequests: [] });
  } }) as Runtime;
  const engine = new Engine(store, runtime, dir);
  try {
    store.put("settings", { orchestrator: { model: "gpt-6.1-sol", effort: "high" },
      subagent: { model: "gpt-6-sol", effort: "medium" } }, "settings");
    const project = store.put("project", { path: dir, status: "running", planned: true,
      escalationMode: "human", goal: "Measure refresh", constraints: "" });
    const gate = engine.gate(project.id, "Round decision", "Assess exhausted round", "decision");
    await engine.judge(store.get(project.id), gate);
    assert.ok(schema);
    assert.equal(JSON.stringify(schema).includes('"propertyNames"'), false);
    const thresholds = schema.properties.nextRound.properties.contract.properties.thresholds;
    assert.equal(thresholds.additionalProperties, false);
    assert.deepEqual(Object.keys(thresholds.properties).sort(),
      ["minMedianImprovementPercent", "maxOtherMedianRegressionPercent", "requiredChecks"].sort());
    assert.equal(thresholds.properties.minMedianImprovementPercent.type, "number");
    assert.equal(thresholds.properties.maxOtherMedianRegressionPercent.type, "number");
    assert.equal(thresholds.properties.requiredChecks.type, "string");
  } finally { engine.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
