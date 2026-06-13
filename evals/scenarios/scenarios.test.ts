import { describe, expect, test } from "bun:test";
import { loadRegistry, serializeScenario, validateScenario } from "../src/registry.ts";
import { validateSqlDumpText } from "../src/runner/index.ts";
import { scenarioWorkerCount } from "../src/types.ts";
import { DEFAULT_SCENARIO_IDS, scenarios } from "./index.ts";

/**
 * Registry-load gate for the bundled scenarios (v6 WP-B): every registered
 * scenario passes the frozen §0.11 validation, the new-machinery scenarios
 * carry the shapes the spec pins, and the sql fixture on disk satisfies the
 * frozen §1.3 content rules.
 */

const EXPECTED_IDS = [
  "sql-seeded-history",
  "memory-seeded-recall",
  "memory-pipeline",
  "two-workers",
  "relay-handoff",
  "build-verify-fix",
  "roster-demo",
];

describe("scenario registry", () => {
  test("loadRegistry() validates and includes all bundled scenarios", () => {
    const registry = loadRegistry();
    for (const id of EXPECTED_IDS) {
      expect(registry.scenarios.has(id)).toBe(true);
    }
  });

  test("the v7 §5.1 dummies are gone and the smoke scenario is the default", () => {
    const registry = loadRegistry();
    expect(registry.scenarios.has("hello-file")).toBe(false);
    expect(registry.scenarios.has("quick-reasoning")).toBe(false);
    expect(DEFAULT_SCENARIO_IDS).toEqual(["memory-seeded-recall"]);
    expect(registry.scenarios.get("memory-seeded-recall")?.description).toContain(
      "Designated smoke scenario",
    );
  });

  test("scenario ids are unique", () => {
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every bundled scenario passes validateScenario individually", () => {
    for (const s of scenarios) {
      expect({ id: s.id, errors: validateScenario(s) }).toEqual({ id: s.id, errors: [] });
    }
  });

  test("every bundled scenario serializes (API/UI shape)", () => {
    for (const s of scenarios) {
      const serialized = serializeScenario(s);
      expect(serialized.id).toBe(s.id);
      expect(serialized.workers).toBe(scenarioWorkerCount(s.workers));
      expect(serialized.tasks.length).toBe(s.tasks.length);
    }
  });
});

describe("spec'd scenario shapes (v6)", () => {
  const byId = new Map(scenarios.map((s) => [s.id, s]));

  test("sql-seeded-history seeds from seeded-history.sql with both proof checks", () => {
    const s = byId.get("sql-seeded-history");
    expect(s?.seed?.sqlDump).toBe("seeded-history.sql");
    const checkNames = (s?.outcome.checks ?? []).map((c) => c.name);
    expect(checkNames).toContain("seeded-task-visible");
    expect(checkNames).toContain("file-contains:/workspace/seeded-task.txt");
  });

  test("memory-seeded-recall seeds exactly one memory and checks the recall file", () => {
    const s = byId.get("memory-seeded-recall");
    expect(s?.seed?.memories?.length).toBe(1);
    expect(s?.seed?.memories?.[0]).toContain("nightjar-prod.internal");
    const checkNames = (s?.outcome.checks ?? []).map((c) => c.name);
    expect(checkNames).toContain("file-contains:/workspace/nightjar-deploy.txt");
  });

  test("memory-pipeline chains task 2 on task 1 via native dependsOn (§9.6)", () => {
    const s = byId.get("memory-pipeline");
    expect(s?.tasks.length).toBe(2);
    expect(s?.tasks[1]?.dependsOn).toEqual([0]);
    expect(s?.seed).toBeUndefined();
    expect(s?.outcome.agenticJudge).toBeDefined();
  });

  test("two-workers routes one task per worker with both isolation checks (§3.5)", () => {
    const s = byId.get("two-workers");
    expect(s?.workers).toBe(2);
    expect(s?.tasks.map((t) => t.worker)).toEqual([0, 1]);
    const checkNames = (s?.outcome.checks ?? []).map((c) => c.name);
    expect(checkNames).toEqual([
      "file-contains[w0]:/workspace/eval-worker-a.txt",
      "file-contains[w1]:/workspace/eval-worker-b.txt",
      "file-absent[w0]:/workspace/eval-worker-b.txt",
      "file-absent[w1]:/workspace/eval-worker-a.txt",
    ]);
    // deliberately dep-free: gates the unchanged sequential creation mode
    expect(s?.tasks.every((t) => !t.dependsOn?.length)).toBe(true);
  });

  test("relay-handoff crosses workers through a dependency chain (§13 S1)", () => {
    const s = byId.get("relay-handoff");
    expect(s?.workers).toBe(2);
    expect(s?.tasks[0]?.worker).toBe(0);
    expect(s?.tasks[1]?.worker).toBe(1);
    expect(s?.tasks[1]?.dependsOn).toEqual([0]);
    expect(s?.seed?.exec?.length).toBe(1);
    expect(s?.seed?.exec?.[0]).toContain("relay-7f3a9c");
    const checkNames = (s?.outcome.checks ?? []).map((c) => c.name);
    expect(checkNames).toContain("file-contains[w1]:/workspace/relay-received.txt");
    expect(checkNames).toContain("file-absent[w0]:/workspace/relay-received.txt");
  });

  test("roster-demo exercises the v7 heterogeneous roster: specs, overrides, lead routing", () => {
    const s = byId.get("roster-demo");
    expect(Array.isArray(s?.workers)).toBe(true);
    const workers = s?.workers as import("../src/types.ts").WorkerSpec[];
    expect(workers).toHaveLength(2);
    // worker 0: cell config + identity (template/name) — NOT overridden
    expect(workers[0]).toEqual({ name: "scribe-a", template: "coder" });
    // worker 1: catalog config override
    expect(workers[1]).toEqual({ name: "scribe-b", configId: "pi-deepseek-flash" });
    // lead: stronger-model override + the official lead template
    expect(s?.lead).toEqual({ name: "Lead", template: "lead", configId: "claude-sonnet" });
    // one task per worker by index + the lead task via worker: "lead"
    expect(s?.tasks.map((t) => t.worker)).toEqual([0, 1, "lead"]);
    // deterministic-only — zero judge LLM spend
    expect(s?.outcome.llmJudge).toBeUndefined();
    expect(s?.outcome.agenticJudge).toBeUndefined();
    const checkNames = (s?.outcome.checks ?? []).map((c) => c.name);
    expect(checkNames).toEqual([
      "file-contains[w0]:/workspace/roster-a.txt",
      "file-contains[w1]:/workspace/roster-b.txt",
      "file-contains[w2]:/workspace/roster-lead.txt",
    ]);

    // serialization (v4 SerializedScenario): workerSpecs + lead survive
    const serialized = serializeScenario(s as import("../src/types.ts").Scenario);
    expect(serialized.workers).toBe(2);
    expect(serialized.workerSpecs?.map((w) => w.name)).toEqual(["scribe-a", "scribe-b"]);
    expect(serialized.workerSpecs?.[1]?.configId).toBe("pi-deepseek-flash");
    expect(serialized.lead?.configId).toBe("claude-sonnet");
    expect(serialized.tasks[2]?.worker).toBe("lead");
  });

  test("build-verify-fix seeds the test suite and grades by re-running it (§13 S2)", () => {
    const s = byId.get("build-verify-fix");
    expect(s?.workers ?? 1).toBe(1);
    expect(s?.tasks[1]?.dependsOn).toEqual([0]);
    expect(s?.seed?.exec?.[0]).toContain("/workspace/calc/calc.test.ts");
    expect(s?.seed?.exec?.[0]).toContain("pow(2, -2)");
    const checkNames = (s?.outcome.checks ?? []).map((c) => c.name);
    expect(checkNames).toContain("bun-test-green");
  });
});

describe("seeded-history.sql fixture", () => {
  test("exists where the runner resolves it and passes the frozen §1.3 content rules", async () => {
    const file = Bun.file(new URL("./fixtures/seeded-history.sql", import.meta.url));
    expect(await file.exists()).toBe(true);
    const text = await file.text();
    expect(validateSqlDumpText(text)).toBeNull();
    // the one seeded historical row the scenario is built around
    expect(text).toMatch(/Calibrate the flux capacitor/);
    expect(text).toMatch(/'completed'/);
  });
});
