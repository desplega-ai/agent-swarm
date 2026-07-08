import { describe, expect, test } from "bun:test";
import { normalizeOutcome } from "../src/normalize-outcome.ts";
import { loadRegistry, serializeScenario, validateScenario } from "../src/registry.ts";
import { validateSqlDumpText } from "../src/runner/index.ts";
import { type JudgeContext, type JudgeWorkerContext, scenarioWorkerCount } from "../src/types.ts";
import { DEFAULT_SCENARIO_IDS, scenarios } from "./index.ts";

/**
 * A benign stub {@link JudgeContext} for exercising graded-check `fn`s purely for
 * their return shape (not their verdict): every file read misses, every command
 * fails, every API call returns nothing. Checks must still return a numeric
 * `score` (here 0) rather than throwing — that's the contract this file asserts.
 * Sized to cover the lead too (worker index === count), so multi-worker checks
 * that target a specific worker find a context entry instead of going undefined.
 */
function stubJudgeContext(workerCount: number): JudgeContext {
  const exec = async () => ({ exitCode: 1, stdout: "", stderr: "" });
  const readFile = async () => null;
  const workers: JudgeWorkerContext[] = Array.from({ length: workerCount + 1 }, (_, index) => ({
    index,
    agentId: `stub-${index}`,
    exec,
    readFile,
  }));
  return { tasks: [], transcript: "", exec, readFile, apiGet: async () => null, workers };
}

/**
 * Registry-load gate for the bundled scenarios. The v8.0 round-11 catalog
 * replaces the 7 old scenarios with the 7 new discriminating ones; this file is
 * EXTENDED as each new scenario is authored (one `spec'd scenario shapes`
 * describe block per scenario). The generic assertions iterate `scenarios`, so
 * they hold for whatever subset of the round-11 catalog is currently registered.
 */

// Currently-registered round-11 scenario ids. The swarm-redesign prune (Plan A)
// removed the four clearly-measured non-discriminators (memory-coordination,
// failure-recovery, failure-recovery-mixed, cross-worker-invent); a follow-up
// scenario audit additionally killed plan-implement-review (expensive lead+2; only
// a noisy weight-1 judge moved the aggregate). What remains still discriminates
// harness+model or swarm mechanics.
const EXPECTED_IDS = [
  "sql-audit",
  "delegation-probe",
  "workflow-authoring",
  "script-authoring",
  "delegation-chain",
  "tool-routing",
  "structured-output-adherence",
];

describe("scenario registry", () => {
  test("loadRegistry() validates and includes all bundled scenarios", () => {
    const registry = loadRegistry();
    for (const id of EXPECTED_IDS) {
      expect(registry.scenarios.has(id)).toBe(true);
    }
    // Exactly the registered round-11 scenarios — no leftover old ids.
    expect([...registry.scenarios.keys()].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  test("the deleted old scenarios are gone", () => {
    const registry = loadRegistry();
    for (const dead of [
      "sql-seeded-history",
      "memory-seeded-recall",
      "memory-pipeline",
      "two-workers",
      "relay-handoff",
      "build-verify-fix",
      "roster-demo",
      "hello-file",
      "quick-reasoning",
      // Plan A swarm-redesign prune: clearly-measured non-discriminators.
      "memory-coordination",
      "failure-recovery",
      "failure-recovery-mixed",
      "cross-worker-invent",
      // Follow-up scenario audit KILL: expensive lead+2, only a noisy weight-1
      // judge moved the aggregate.
      "plan-implement-review",
      // v9 orchestration-substrate cleanup: saturated or zero-pilot legacy axes
      // are demoted from the active registry. Source files may remain for
      // historical reference, but they must not run by default.
      "bug-ladder",
      "memory-distractor",
      "relay-pipeline",
      "distributed-audit",
    ]) {
      expect(registry.scenarios.has(dead)).toBe(false);
    }
  });

  test("DEFAULT_SCENARIO_IDS all resolve in the registry", () => {
    const registry = loadRegistry();
    for (const id of DEFAULT_SCENARIO_IDS) {
      expect(registry.scenarios.has(id)).toBe(true);
    }
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

  test("every round-11 scenario carries gates + ≥1 weighted dimension (v8.0)", () => {
    for (const s of scenarios) {
      const serialized = serializeScenario(s);
      // gates always include the synthetic tasks-completed gate + the report/output gate(s).
      expect(serialized.outcome.gates.length).toBeGreaterThan(0);
      expect(serialized.outcome.dimensions.length).toBeGreaterThan(0);
      for (const dim of serialized.outcome.dimensions) {
        expect(dim.weight).toBeGreaterThan(0);
        // Each dimension is fed by graded checks OR a judge — EXCEPT the
        // deterministic `efficiency` dimension (v8.0 §5), which the runner scores
        // from the attempt's real cost/time vs a scenario budget (no checks/judge).
        const isDeterministicEfficiency =
          dim.name === "efficiency" && dim.checks.length === 0 && !dim.judge;
        if (isDeterministicEfficiency) {
          // It must be budget-backed (else the runner re-normalizes it out).
          expect(serialized.budgetUsd !== null || serialized.budgetMs !== null).toBeTruthy();
        } else {
          // Checks XOR judge (round 11): exactly one source of truth — never both
          // (the runner short-circuits on checks, so a co-set judge would be dead).
          expect(dim.checks.length > 0 || dim.judge).toBeTruthy();
          expect(dim.checks.length > 0 && dim.judge).toBeFalsy();
        }
      }
    }
  });

  test("every graded dimension check returns a numeric score (v8.0)", async () => {
    for (const s of scenarios) {
      const ctx = stubJudgeContext(scenarioWorkerCount(s.workers));
      const { dimensions } = normalizeOutcome(s.outcome);
      // At least one dimension across the catalog must be fed by graded checks
      // (the partial-credit signal); assert each such check returns a score.
      const gradedChecks = dimensions.flatMap((d) => d.checks ?? []);
      for (const check of gradedChecks) {
        const result = await check.fn(ctx);
        expect(typeof result.score, `${s.id} › ${check.name} must return a numeric score`).toBe(
          "number",
        );
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("spec'd scenario shapes (v9 orchestration substrate)", () => {
  const byId = new Map(scenarios.map((s) => [s.id, s]));

  test("sql-audit seeds the audit dump and grades correctness + communication", () => {
    const s = byId.get("sql-audit");
    expect(s).toBeDefined();
    expect(s?.workers ?? 1).toBe(1);
    expect(s?.seed?.sqlDump).toBe("sql-audit-history.sql");
    expect(s?.tasks.length).toBe(1);
    expect(s?.timeoutMs).toBe(12 * 60_000);

    // Two weighted dimensions: graded correctness (3 answer-key checks) +
    // a communication judge.
    const dims = s?.outcome.dimensions ?? [];
    const correctness = dims.find((d) => d.name === "correctness");
    const communication = dims.find((d) => d.name === "communication");
    expect(correctness?.weight).toBe(3);
    expect(communication?.weight).toBe(1);
    expect(communication?.judge?.agentic).toBe(true);

    // The three answer-key checks (count → which → cross-reference anomaly).
    const checkNames = (correctness?.checks ?? []).map((c) => c.name);
    expect(checkNames).toEqual([
      "audit:completed-count",
      "audit:top-priority-completed",
      "audit:anomaly",
    ]);

    // The report file is a binary must-pass gate (required output surface).
    const gateNames = (s?.outcome.gates ?? []).map((g) => g.name);
    expect(gateNames).toContain("file-contains:/workspace/audit/report.md");

    // Anti-gaming: the answer-key values never appear in the task prompt.
    const promptText = `${s?.description ?? ""}\n${s?.tasks.map((t) => `${t.title}\n${t.description}`).join("\n")}`;
    expect(promptText).not.toMatch(/\b21\b/); // Q1 count
    expect(promptText).not.toMatch(/Rotate the payments service API keys/); // Q2 answer
    expect(promptText).not.toMatch(/Deploy the checkout redesign to production/); // Q3 answer
  });

  test("workflow-authoring grades workflow DAG behavior without a judge", () => {
    const s = byId.get("workflow-authoring")!;
    const outcome = s.outcome!;
    const gates = outcome.gates!;
    const dimensions = outcome.dimensions!;
    expect(s).toBeDefined();
    expect(s.workers ?? 1).toBe(1);
    expect(s.tasks.length).toBe(1);
    expect(gates.map((g) => g.name)).toContain("workflow-exists");
    expect(dimensions.map((d) => d.name)).toEqual([
      "workflow-dag",
      "trigger-schema",
      "correctness",
    ]);
    expect(dimensions.some((d) => d.judge)).toBe(false);
  });

  test("script-authoring grades upsert/run behavior and source discipline", () => {
    const s = byId.get("script-authoring")!;
    const outcome = s.outcome!;
    const gates = outcome.gates!;
    const dimensions = outcome.dimensions!;
    expect(s).toBeDefined();
    expect(s.workers ?? 1).toBe(1);
    expect(gates.map((g) => g.name)).toContain("script-created");
    expect(dimensions.map((d) => d.name)).toEqual([
      "script-behavior",
      "correctness",
      "reusability",
    ]);
    expect(`${s.tasks[0]?.description}`).toMatch(/script-upsert/);
    expect(`${s.tasks[0]?.description}`).toMatch(/script-run/);
  });

  test("delegation-chain uses a lead plus three workers and grades dependsOn chains", () => {
    const s = byId.get("delegation-chain")!;
    const outcome = s.outcome!;
    const dimensions = outcome.dimensions!;
    expect(s).toBeDefined();
    expect(scenarioWorkerCount(s.workers)).toBe(3);
    expect(s.lead?.template).toBe("lead");
    expect(s.seed?.sqlDump).toBe("sql-audit-history.sql");
    expect(s.tasks[0]?.worker).toBe("lead");
    expect(dimensions.map((d) => d.name)).toEqual([
      "delegation-chain",
      "dispatch-structure",
      "correctness",
    ]);
  });

  test("tool-routing grades MCP tool selection from session logs", () => {
    const s = byId.get("tool-routing")!;
    const outcome = s.outcome!;
    const dimensions = outcome.dimensions!;
    expect(s).toBeDefined();
    expect(s.workers ?? 1).toBe(1);
    expect((s.seed?.memories ?? []).join("\n")).toMatch(/Project Alpha/);
    expect(dimensions.map((d) => d.name)).toEqual([
      "tool-selection",
      "dispatch-order",
      "correctness",
    ]);
    expect(`${s.tasks[0]?.description}`).toMatch(/KV/);
    expect(`${s.tasks[0]?.description}`).toMatch(/Avoid raw curl/);
  });

  test("structured-output-adherence forwards a real task outputSchema", () => {
    const s = byId.get("structured-output-adherence")!;
    const outcome = s.outcome!;
    const dimensions = outcome.dimensions!;
    expect(s).toBeDefined();
    expect(s.tasks[0]?.outputSchema).toBeDefined();
    expect(s.tasks[0]?.outputSchema?.required).toEqual([
      "summary",
      "risks",
      "nextAction",
      "confidence",
    ]);
    expect(dimensions.map((d) => d.name)).toEqual(["instruction-following"]);
  });
});

describe("sql-audit-history.sql fixture", () => {
  test("exists where the runner resolves it and passes the INSERT-only seed rules", async () => {
    const file = Bun.file(new URL("./fixtures/sql-audit-history.sql", import.meta.url));
    expect(await file.exists()).toBe(true);
    const text = await file.text();
    expect(validateSqlDumpText(text)).toBeNull();
    // INSERT-only seed: no schema, no `_migrations` (built pre-boot from the real migrations).
    expect(text).toMatch(/sql-audit seed/);
    expect(text).not.toMatch(/CREATE\s+TABLE/i);
    expect(text).not.toMatch(/_migrations/i);
    // Answer-key rows are present in the seed data.
    expect(text).toMatch(/Rotate the payments service API keys/);
    expect(text).toMatch(/Deploy the checkout redesign to production/);
  });
});
