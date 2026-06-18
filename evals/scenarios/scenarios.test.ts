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
  "memory-distractor",
  "bug-ladder",
  "relay-pipeline",
  "distributed-audit",
  "delegation-probe",
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

describe("spec'd scenario shapes (v8.0 round-11)", () => {
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

  test("memory-distractor seeds ground-truth memories and grades recall + retrieval-fidelity", () => {
    const s = byId.get("memory-distractor");
    expect(s).toBeDefined();
    expect(s?.workers ?? 1).toBe(1);
    expect(s?.tasks.length).toBe(1);
    expect(s?.timeoutMs).toBe(8 * 60_000);

    // Three seeded ground-truth memories carry the canonical config (host/port/rollout).
    expect((s?.seed?.memories ?? []).length).toBe(3);

    // Two weighted dimensions: graded per-fact correctness + a custom agentic
    // retrieval-fidelity judge.
    const dims = s?.outcome.dimensions ?? [];
    const correctness = dims.find((d) => d.name === "correctness");
    const fidelity = dims.find((d) => d.name === "retrieval-fidelity");
    expect(correctness?.weight).toBe(3);
    expect(fidelity?.weight).toBe(1);
    // retrieval-fidelity is an agentic judge (Phase 4: cross-checks the sandbox).
    expect(fidelity?.judge?.agentic).toBe(true);
    expect(fidelity?.checks ?? []).toHaveLength(0);

    // Correctness is fed by the graded facts-recalled check (partial credit).
    const checkNames = (correctness?.checks ?? []).map((c) => c.name);
    expect(checkNames).toEqual(["facts-recalled[w0]:/workspace/halberd/deploy-config.txt"]);

    // The recall file is a binary must-pass gate (required output surface).
    const gateNames = (s?.outcome.gates ?? []).map((g) => g.name);
    expect(gateNames).toContain("file-contains:/workspace/halberd/deploy-config.txt");

    // Anti-gaming: the ground-truth (correct) values NEVER appear in the prompt —
    // only the WRONG distractor defaults do. A prompt-echo or guess scores 0.
    const promptText = `${s?.description ?? ""}\n${s?.tasks.map((t) => `${t.title}\n${t.description}`).join("\n")}`;
    expect(promptText).not.toMatch(/halberd-prod-3\.svc\.internal/); // host answer
    expect(promptText).not.toMatch(/\b7711\b/); // port answer
    expect(promptText).not.toMatch(/canary/i); // rollout answer
    // The plausible-WRONG distractors ARE present in the prompt (they're the trap).
    expect(promptText).toMatch(/halberd\.internal/);
    expect(promptText).toMatch(/\b8080\b/);
    expect(promptText).toMatch(/blue-green/);

    // The ground-truth values DO live in the seeded memories (the only source).
    const memoryText = (s?.seed?.memories ?? []).join("\n");
    expect(memoryText).toMatch(/halberd-prod-3\.svc\.internal/);
    expect(memoryText).toMatch(/\b7711\b/);
    expect(memoryText).toMatch(/canary/i);
  });

  test("bug-ladder seeds the buggy project and grades correctness + instruction-following + efficiency", () => {
    const s = byId.get("bug-ladder");
    expect(s).toBeDefined();
    expect(s?.workers ?? 1).toBe(1);
    expect(s?.tasks.length).toBe(2);
    expect(s?.timeoutMs).toBe(15 * 60_000);

    // Efficiency is a waste-guard, not a quality lever (round-11): a $1.5 cost
    // budget so a normal frontier run (~$0.8) scores 1.0 and only an egregious
    // (>2-3×) overspend is penalized.
    expect(s?.budgetUsd).toBe(1.5);
    expect(s?.budgetMs).toBeUndefined();

    // The fix task depends on the survey task (build-verify-fix machinery).
    expect(s?.tasks[1]?.dependsOn).toEqual([0]);

    // Seeds the project source + five per-bug test files via seed.exec heredocs.
    const execSeed = (s?.seed?.exec ?? []).join("\n");
    expect(execSeed).toMatch(/textkit\.ts/);
    for (const n of [1, 2, 3, 4, 5]) {
      expect(execSeed).toMatch(new RegExp(`bug${n}\\.test\\.ts`));
    }

    // Three weighted dimensions: graded correctness (test groups) + tests-
    // unmodified instruction-following + deterministic efficiency.
    const dims = s?.outcome.dimensions ?? [];
    const correctness = dims.find((d) => d.name === "correctness");
    const instruction = dims.find((d) => d.name === "instruction-following");
    const efficiency = dims.find((d) => d.name === "efficiency");
    expect(correctness?.weight).toBe(3);
    expect(instruction?.weight).toBe(1);
    expect(efficiency?.weight).toBe(1);

    // Correctness is fed by the graded testGroupsGreen check (fraction green).
    const ccNames = (correctness?.checks ?? []).map((c) => c.name);
    expect(ccNames).toEqual(["test-groups-green[w0]"]);

    // instruction-following is the tests-unmodified anti-gaming check.
    const ifNames = (instruction?.checks ?? []).map((c) => c.name);
    expect(ifNames).toEqual(["tests-unmodified"]);

    // efficiency is the DETERMINISTIC dimension: no checks, no judge (the runner
    // scores it from the attempt's real cost vs budgetUsd).
    expect(efficiency?.checks ?? []).toHaveLength(0);
    expect(efficiency?.judge).toBeUndefined();

    // The source module is a binary must-pass gate (required output surface).
    const gateNames = (s?.outcome.gates ?? []).map((g) => g.name);
    expect(gateNames).toContain("src-exists");

    // Anti-gaming: the bug FIXES / expected values are NOT in the task prompt —
    // only the seeded test bodies pin them down. The prompt names no function fix
    // and no expected output token.
    const promptText = `${s?.description ?? ""}\n${s?.tasks.map((t) => `${t.title}\n${t.description}`).join("\n")}`;
    expect(promptText).not.toMatch(/glyphLength/); // fn name lives only in the seeded module/tests
    expect(promptText).not.toMatch(/countVowels/);
    expect(promptText).not.toMatch(/code point/i); // the subtle-bug fix hint
  });

  test("relay-pipeline runs a 3-stage transform chain and grades correctness + completeness", () => {
    const s = byId.get("relay-pipeline");
    expect(s).toBeDefined();
    // Three workers (the cap), no lead, three strictly-chained stage tasks.
    expect(s?.workers).toBe(3);
    expect(s?.lead).toBeUndefined();
    expect(s?.tasks.length).toBe(3);
    expect(s?.timeoutMs).toBe(12 * 60_000);

    // Stages fan along a strict chain: A=0 → B=1 (dependsOn A) → C=2 (dependsOn B).
    expect(s?.tasks[0]?.worker).toBe(0);
    expect(s?.tasks[1]?.worker).toBe(1);
    expect(s?.tasks[2]?.worker).toBe(2);
    expect(s?.tasks[1]?.dependsOn).toEqual([0]);
    expect(s?.tasks[2]?.dependsOn).toEqual([1]);

    // seed.exec only prepares worker 0's pipeline dir + the random source payload
    // (seed runs on worker 0 only); the payload is generated at runtime via awk.
    const execSeed = (s?.seed?.exec ?? []).join("\n");
    expect(execSeed).toMatch(/\/workspace\/pipeline/);
    expect(execSeed).toMatch(/source\.csv/);
    expect(execSeed).toMatch(/srand\(\)/); // random per-attempt payload

    // Two weighted dimensions: graded per-stage correctness (3×) + completeness (1×).
    const dims = s?.outcome.dimensions ?? [];
    const correctness = dims.find((d) => d.name === "correctness");
    const completeness = dims.find((d) => d.name === "completeness");
    expect(correctness?.weight).toBe(3);
    expect(completeness?.weight).toBe(1);
    // Both are deterministic graded checks (no judge) — fully checkable per stage.
    expect(correctness?.judge).toBeUndefined();
    expect(completeness?.judge).toBeUndefined();

    // Correctness is fed by the single graded pipeline-stages check (partial
    // credit over the three chained stages).
    expect((correctness?.checks ?? []).length).toBe(1);
    expect((correctness?.checks ?? [])[0]?.name).toMatch(/^pipeline-stages:/);
    // Completeness is fed by the stage-receipts-present check.
    expect((completeness?.checks ?? []).map((c) => c.name)).toEqual(["pipeline-stages-present"]);

    // Gates: source payload exists + isolation proofs that A's source file did NOT
    // leak onto B/C (the handoff was through memory, not a shared disk).
    const gateNames = (s?.outcome.gates ?? []).map((g) => g.name);
    expect(gateNames).toContain("source-exists");
    expect(gateNames).toContain("file-absent[w1]:/workspace/pipeline/source.csv");
    expect(gateNames).toContain("file-absent[w2]:/workspace/pipeline/source.csv");

    // Anti-gaming: the source payload is per-attempt random, so no concrete record
    // value appears in the prompt — there is nothing to echo or guess. The prompt
    // states the transform SPEC but contains no `<id>,<value>` data rows.
    const promptText = `${s?.description ?? ""}\n${s?.tasks.map((t) => `${t.title}\n${t.description}`).join("\n")}`;
    // No literal data record of the seeded shape (a number, comma, then a word).
    expect(promptText).not.toMatch(/^\s*\d+,[a-z]+\s*$/m);
  });

  test("distributed-audit shards a seeded audit across 2 workers and merges via a lead", () => {
    const s = byId.get("distributed-audit");
    expect(s).toBeDefined();
    // Two workers (under the cap) + a lead (outside the cap), three tasks.
    expect(scenarioWorkerCount(s?.workers)).toBe(2);
    expect(s?.lead).toBeDefined();
    expect(s?.lead?.template).toBe("lead");
    expect(s?.tasks.length).toBe(3);
    // Raised timeout — a deep distributed data scenario.
    expect(s?.timeoutMs).toBe(18 * 60_000);

    // Reuses the shared sql-audit dump (same seeded history as sql-audit).
    expect(s?.seed?.sqlDump).toBe("sql-audit-history.sql");

    // Task fan: shard A on worker 0, shard B on worker 1, merge on the lead
    // (dependsOn BOTH shards). The lead does NOT count toward the worker cap.
    expect(s?.tasks[0]?.worker).toBe(0);
    expect(s?.tasks[1]?.worker).toBe(1);
    expect(s?.tasks[2]?.worker).toBe("lead");
    expect(s?.tasks[2]?.dependsOn).toEqual([0, 1]);

    // Three weighted dimensions: shard-coverage completeness (2×) + merged
    // answer-key correctness (3×) + a communication judge (1×).
    const dims = s?.outcome.dimensions ?? [];
    const completeness = dims.find((d) => d.name === "completeness");
    const correctness = dims.find((d) => d.name === "correctness");
    const communication = dims.find((d) => d.name === "communication");
    expect(completeness?.weight).toBe(2);
    expect(correctness?.weight).toBe(3);
    expect(communication?.weight).toBe(1);
    // communication is an agentic judge (Phase 4: reads the lead's merged report).
    expect(communication?.judge?.agentic).toBe(true);
    expect(communication?.checks ?? []).toHaveLength(0);

    // Completeness is fed by the graded shard-coverage check; correctness by the
    // graded merged-answer-key check.
    expect((completeness?.checks ?? []).map((c) => c.name)).toEqual(["shard-coverage"]);
    expect((correctness?.checks ?? []).map((c) => c.name)).toEqual(["merged-answer-key"]);

    // The merged report on the LEAD's sandbox (member index 2) is a binary
    // must-pass gate (required output surface).
    const gateNames = (s?.outcome.gates ?? []).map((g) => g.name);
    expect(gateNames).toContain("file-contains[w2]:/workspace/audit/merged-report.md");

    // Anti-gaming: the answer-key VALUES never appear in any prompt — only the
    // seeded DB rows carry them. Echoing the prompt or guessing scores 0.
    const promptText = `${s?.description ?? ""}\n${s?.tasks.map((t) => `${t.title}\n${t.description}`).join("\n")}`;
    expect(promptText).not.toMatch(/\b21\b/); // completed count
    expect(promptText).not.toMatch(/Rotate the payments service API keys/); // top-priority answer
    expect(promptText).not.toMatch(/Deploy the checkout redesign to production/); // anomaly answer
    // The numeric shard counts (failed=5, cancelled=4) are not stated either.
    expect(promptText).not.toMatch(/\b5\s+(failed|tasks? failed)/i);
    expect(promptText).not.toMatch(/\b4\s+(cancell?ed|tasks? cancell?ed)/i);
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
