import { describe, expect, test } from "bun:test";
import { configs } from "../configs/index.ts";
import {
  CONFIG_PRESETS,
  expandPresetSelection,
  presetRunDefaults,
  presetScenarioIds,
  SCHEDULED_PRESET_IDS,
} from "../configs/presets.ts";
import { SCENARIO_CARDS, scenarioCard } from "../scenarios/cards.ts";
import { scenarios } from "../scenarios/index.ts";
import { SCENARIO_HASHES } from "../scenarios/scenario-hashes.ts";
import { canarySuiteScenarioIds, isHeldOut, SUITE_SCENARIO_VERSIONS } from "../scenarios/suite.ts";
import { serializeConfig, serializeScenario, validateScenario } from "./registry.ts";
import {
  type CheckResult,
  type DeterministicCheck,
  type DimensionSpec,
  type Scenario,
  scenarioWorkerCount,
} from "./types.ts";

/** Minimal valid scenario; tests override single fields to isolate one rule. */
function scenario(overrides: Partial<Scenario>): Scenario {
  return {
    id: "test-scenario",
    version: 1,
    name: "Test scenario",
    tasks: [{ title: "t0", description: "d0" }],
    outcome: {},
    ...overrides,
  };
}

describe("validateScenario (v6 §0.11 frozen rules)", () => {
  test("a plain single-task scenario is valid", () => {
    expect(validateScenario(scenario({}))).toEqual([]);
  });

  test("version must be a positive integer", () => {
    expect(validateScenario(scenario({ version: 3 }))).toEqual([]);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(validateScenario(scenario({ version: bad }))).toEqual([
        `version must be a positive integer, got ${bad}`,
      ]);
    }
  });

  test("workers bounds: 1..3 accepted, 0 / 4 / non-integers rejected", () => {
    expect(validateScenario(scenario({ workers: 1 }))).toEqual([]);
    expect(validateScenario(scenario({ workers: 3 }))).toEqual([]);
    expect(validateScenario(scenario({ workers: 0 }))).not.toEqual([]);
    expect(validateScenario(scenario({ workers: 4 }))).not.toEqual([]);
    expect(validateScenario(scenario({ workers: 1.5 }))).not.toEqual([]);
  });

  test("task.worker must be an integer within [0, workers)", () => {
    const base = {
      workers: 2,
      tasks: [
        { title: "a", description: "d", worker: 0 },
        { title: "b", description: "d", worker: 1 },
      ],
    };
    expect(validateScenario(scenario(base))).toEqual([]);
    expect(
      validateScenario(
        scenario({ workers: 2, tasks: [{ title: "a", description: "d", worker: 2 }] }),
      ),
    ).not.toEqual([]);
    // default workers = 1 → worker 1 is out of range
    expect(
      validateScenario(scenario({ tasks: [{ title: "a", description: "d", worker: 1 }] })),
    ).not.toEqual([]);
    expect(
      validateScenario(scenario({ tasks: [{ title: "a", description: "d", worker: -1 }] })),
    ).not.toEqual([]);
    expect(
      validateScenario(
        scenario({ workers: 2, tasks: [{ title: "a", description: "d", worker: 0.5 }] }),
      ),
    ).not.toEqual([]);
  });

  test("seed.sqlDump must be a bare .sql filename (no path separators)", () => {
    const withDump = (sqlDump: string) => scenario({ seed: { sqlDump } });
    expect(validateScenario(withDump("seeded-history.sql"))).toEqual([]);
    expect(validateScenario(withDump("Seed_v2.0-final.sql"))).toEqual([]);
    expect(validateScenario(withDump("nested/path.sql"))).not.toEqual([]);
    expect(validateScenario(withDump("../escape.sql"))).not.toEqual([]);
    expect(validateScenario(withDump("no-extension"))).not.toEqual([]);
    expect(validateScenario(withDump("wrong.sqlite"))).not.toEqual([]);
    expect(validateScenario(withDump("has space.sql"))).not.toEqual([]);
  });

  test("seed.memories: non-empty strings, max 16 entries", () => {
    expect(validateScenario(scenario({ seed: { memories: ["a fact"] } }))).toEqual([]);
    expect(
      validateScenario(scenario({ seed: { memories: Array.from({ length: 16 }, () => "m") } })),
    ).toEqual([]);
    expect(
      validateScenario(scenario({ seed: { memories: Array.from({ length: 17 }, () => "m") } })),
    ).not.toEqual([]);
    expect(validateScenario(scenario({ seed: { memories: [""] } }))).not.toEqual([]);
    expect(validateScenario(scenario({ seed: { memories: ["ok", "   "] } }))).not.toEqual([]);
  });

  describe("dependsOn rules (round 10: range + self + whole-graph cycle check)", () => {
    const tasks3 = (deps: { [i: number]: number[] }) =>
      scenario({
        tasks: [
          { title: "t0", description: "d", dependsOn: deps[0] },
          { title: "t1", description: "d", dependsOn: deps[1] },
          { title: "t2", description: "d", dependsOn: deps[2] },
        ],
      });

    test("a valid 3-task chain is accepted", () => {
      expect(validateScenario(tasks3({ 1: [0], 2: [0, 1] }))).toEqual([]);
    });

    test("out-of-range index rejected", () => {
      expect(validateScenario(tasks3({ 1: [-1] }))).not.toEqual([]);
      expect(validateScenario(tasks3({ 1: [5] }))).not.toEqual([]);
    });

    test("acyclic forward reference accepted (round 10 relaxation)", () => {
      expect(validateScenario(tasks3({ 1: [2] }))).toEqual([]);
    });

    test("self-reference rejected", () => {
      expect(validateScenario(tasks3({ 1: [1] }))).not.toEqual([]);
      // task 0 can never have deps (no earlier task exists)
      expect(validateScenario(tasks3({ 0: [0] }))).not.toEqual([]);
    });

    test("duplicates rejected", () => {
      const errors = validateScenario(tasks3({ 2: [0, 0] }));
      expect(errors).not.toEqual([]);
      expect(errors.join("\n")).toContain("duplicate");
    });

    test("non-integer entries rejected", () => {
      expect(validateScenario(tasks3({ 1: [0.5] }))).not.toEqual([]);
    });
  });
});

describe("validateScenario — WorkerSpec[] + lead (v7 §9/§12 frozen rules)", () => {
  test("array shape: 1..3 specs accepted, 0 / 4 rejected", () => {
    expect(validateScenario(scenario({ workers: [{}] }))).toEqual([]);
    expect(validateScenario(scenario({ workers: [{}, {}, {}] }))).toEqual([]);
    expect(validateScenario(scenario({ workers: [] }))).not.toEqual([]);
    expect(validateScenario(scenario({ workers: [{}, {}, {}, {}] }))).not.toEqual([]);
  });

  test("template must be a lowercase slug", () => {
    expect(validateScenario(scenario({ workers: [{ template: "coder" }] }))).toEqual([]);
    expect(validateScenario(scenario({ workers: [{ template: "Bad Slug" }] }))).not.toEqual([]);
  });

  test("names must be non-empty and unique across workers AND the lead", () => {
    expect(validateScenario(scenario({ workers: [{ name: "a" }, { name: "b" }] }))).toEqual([]);
    expect(validateScenario(scenario({ workers: [{ name: " " }] }))).not.toEqual([]);
    expect(validateScenario(scenario({ workers: [{ name: "a" }, { name: "a" }] }))).not.toEqual([]);
    expect(
      validateScenario(scenario({ workers: [{ name: "a" }], lead: { name: "a" } })),
    ).not.toEqual([]);
  });

  test("env keys: SHOUTY_SNAKE only; boot-path-owned keys rejected", () => {
    expect(validateScenario(scenario({ workers: [{ env: { MY_FLAG: "1" } }] }))).toEqual([]);
    expect(validateScenario(scenario({ workers: [{ env: { "bad-key": "1" } }] }))).not.toEqual([]);
    for (const key of [
      "AGENT_ID",
      "HARNESS_PROVIDER",
      "TEMPLATE_ID",
      "AGENT_NAME",
      "SYSTEM_PROMPT",
      "DESPLEGA_TELEMETRY_ENV",
    ]) {
      expect(validateScenario(scenario({ workers: [{ env: { [key]: "x" } }] }))).not.toEqual([]);
    }
  });

  test("configId override must exist in the config catalog", () => {
    expect(validateScenario(scenario({ workers: [{ configId: "claude-fable" }] }))).toEqual([]);
    expect(validateScenario(scenario({ workers: [{ configId: "no-such-config" }] }))).not.toEqual(
      [],
    );
  });

  test("model override must be non-empty when present", () => {
    expect(validateScenario(scenario({ workers: [{ model: "claude-haiku-4-5" }] }))).toEqual([]);
    expect(validateScenario(scenario({ workers: [{ model: "  " }] }))).not.toEqual([]);
  });

  test("lead spec gets the same member rules", () => {
    expect(validateScenario(scenario({ lead: { configId: "claude-fable" } }))).toEqual([]);
    expect(validateScenario(scenario({ lead: { configId: "no-such-config" } }))).not.toEqual([]);
    expect(validateScenario(scenario({ lead: { env: { MODEL_OVERRIDE: "x" } } }))).not.toEqual([]);
  });

  test('task.worker "lead" requires scenario.lead', () => {
    const tasks = [{ title: "t0", description: "d0", worker: "lead" as const }];
    expect(validateScenario(scenario({ tasks }))).not.toEqual([]);
    expect(validateScenario(scenario({ tasks, lead: {} }))).toEqual([]);
  });
});

describe("serializeScenario — workerSpecs + lead (v7 §9/§12)", () => {
  test("numeric workers shape serializes workerSpecs/lead as null", () => {
    const s = serializeScenario(scenario({ workers: 2 }));
    expect(s.workers).toBe(2);
    expect(s.workerSpecs).toBeNull();
    expect(s.lead).toBeNull();
  });

  test("spec array serializes identity + overrides; env keys only, never values", () => {
    const s = serializeScenario(
      scenario({
        workers: [
          { template: "coder", name: "alice", env: { MY_SECRETISH: "value" } },
          { configId: "claude-fable", model: "claude-haiku-4-5" },
        ],
        lead: { name: "lead-1", configId: "claude-fable" },
      }),
    );
    expect(s.workers).toBe(2);
    expect(s.workerSpecs).toEqual([
      {
        template: "coder",
        name: "alice",
        systemPrompt: null,
        configId: null,
        model: null,
        envKeys: ["MY_SECRETISH"],
      },
      {
        template: null,
        name: null,
        systemPrompt: null,
        configId: "claude-fable",
        model: "claude-haiku-4-5",
        envKeys: [],
      },
    ]);
    expect(s.lead).toEqual({
      template: null,
      name: "lead-1",
      systemPrompt: null,
      configId: "claude-fable",
      model: null,
      envKeys: [],
    });
    expect(JSON.stringify(s)).not.toContain("value");
  });
});

describe("CONFIG_PRESETS (v7.7 item 1 — frozen contract)", () => {
  test("display order is frozen: frontier, challengers, oss, claude-family, budget, then the scheduled tiers", () => {
    expect(CONFIG_PRESETS.map((p) => p.id)).toEqual([
      "frontier",
      "challengers",
      "oss",
      "claude-family",
      "budget",
      "nightly-canary",
      "weekly-matrix",
    ]);
  });

  test("scheduled tiers name the plan's reference configs and carry a valid run plan", () => {
    const nightly = CONFIG_PRESETS.find((p) => p.id === "nightly-canary");
    const weekly = CONFIG_PRESETS.find((p) => p.id === "weekly-matrix");
    expect(nightly?.configIds).toEqual(["claude-opus-5.5", "codex-6-luna"]);
    expect(weekly?.configIds).toEqual([
      "claude-opus-5.5",
      "codex-6-luna",
      "codex-6-astra",
      "pi-deepseek-v4.1-flash",
    ]);
    expect(nightly?.runDefaults).toEqual({ attemptsPerCell: 3, maxMeteredUsd: 2 });
    expect(weekly?.runDefaults).toEqual({ attemptsPerCell: 5, maxMeteredUsd: 12 });
    for (const preset of CONFIG_PRESETS) {
      const plan = preset.runDefaults;
      if (!plan) continue;
      expect(Number.isInteger(plan.attemptsPerCell) && plan.attemptsPerCell >= 1).toBe(true);
      expect(Number.isFinite(plan.maxMeteredUsd) && plan.maxMeteredUsd > 0).toBe(true);
    }
  });

  test("the nightly canary runs the 9 public single-run scenarios; every other preset runs the whole suite", () => {
    expect(canarySuiteScenarioIds()).toEqual([
      "sql-audit",
      "delegation-probe",
      "workflow-authoring",
      "script-authoring",
      "tool-routing",
      "fanout-research",
      "worker-recovery",
      "implement-review",
      "human-in-loop",
    ]);
    // no held-out scenario and no -solo baseline: those run in the weekly matrix only
    for (const id of canarySuiteScenarioIds()) {
      expect(isHeldOut(id)).toBe(false);
      expect(id.endsWith("-solo")).toBe(false);
    }
    expect(presetScenarioIds("nightly-canary")).toEqual(canarySuiteScenarioIds());
    expect(presetScenarioIds("weekly-matrix")).toEqual(Object.keys(SUITE_SCENARIO_VERSIONS));
    expect(presetScenarioIds("frontier")).toEqual(Object.keys(SUITE_SCENARIO_VERSIONS));
    expect(() => presetScenarioIds("nope")).toThrow('unknown preset "nope"');
  });

  test("every scheduled preset exists and carries a repeat count and a hard $ cap", () => {
    expect(SCHEDULED_PRESET_IDS).toEqual(["nightly-canary", "weekly-matrix"]);
    for (const id of SCHEDULED_PRESET_IDS) {
      const preset = CONFIG_PRESETS.find((p) => p.id === id);
      expect(preset?.runDefaults?.maxMeteredUsd).toBeGreaterThan(0);
      expect(preset?.runDefaults?.attemptsPerCell).toBeGreaterThanOrEqual(3);
    }
  });

  test("presetRunDefaults: first preset that sets a field wins; presets without a plan add nothing", () => {
    expect(presetRunDefaults(["nightly-canary"])).toEqual({ attemptsPerCell: 3, maxMeteredUsd: 2 });
    expect(presetRunDefaults(["budget", "weekly-matrix"])).toEqual({
      attemptsPerCell: 5,
      maxMeteredUsd: 12,
    });
    expect(presetRunDefaults(["nightly-canary", "weekly-matrix"])).toEqual({
      attemptsPerCell: 3,
      maxMeteredUsd: 2,
    });
    expect(presetRunDefaults(["budget"])).toEqual({});
    expect(() => presetRunDefaults(["nope"])).toThrow('unknown preset "nope"');
  });

  test("preset ids are unique; configIds non-empty with no internal duplicates", () => {
    const ids = CONFIG_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of CONFIG_PRESETS) {
      expect(preset.configIds.length).toBeGreaterThan(0);
      expect(new Set(preset.configIds).size).toBe(preset.configIds.length);
      expect(preset.label.trim().length).toBeGreaterThan(0);
      expect(preset.description.trim().length).toBeGreaterThan(0);
    }
  });

  test("every preset config id resolves in the catalog", () => {
    const catalog = new Set(configs.map((c) => c.id));
    for (const preset of CONFIG_PRESETS) {
      for (const id of preset.configIds) {
        expect(catalog.has(id)).toBe(true);
      }
    }
  });

  test("frontier carries the new pi-gemini-pro config", () => {
    expect(CONFIG_PRESETS.find((p) => p.id === "frontier")?.configIds).toContain("pi-gemini-pro");
  });

  test("frontier carries the round-9 proprietary additions", () => {
    const frontier = CONFIG_PRESETS.find((p) => p.id === "frontier")?.configIds ?? [];
    expect(frontier).toContain("pi-qwen3.7-max");
    expect(frontier).toContain("pi-minimax-m3");
  });

  test("oss carries the round-8 OSS refresh pi/opencode twins", () => {
    const oss = CONFIG_PRESETS.find((p) => p.id === "oss")?.configIds ?? [];
    for (const short of [
      "kimi-k2.6",
      "glm-5.1",
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "nemotron-3-ultra",
      // Round-9 open-weight additions.
      "hy3-preview",
      "step-3.7-flash",
      // Round-10 leaderboard additions (open_weights: true).
      "nemotron-3-super",
      "minimax-m2.7",
    ]) {
      expect(oss).toContain(`pi-${short}`);
      expect(oss).toContain(`opencode-${short}`);
    }
    // Pre-refresh members stay (historical runs reference them).
    for (const id of ["pi-kimi-k2.5", "pi-minimax-m2.5", "opencode-kimi-k2.5"]) {
      expect(oss).toContain(id);
    }
    // open_weights: false additions stay out of oss (round-9 proprietary lift +
    // round-10 leaderboard additions).
    for (const short of [
      "minimax-m3",
      "qwen3.7-max",
      "qwen3.7-plus",
      "grok-4.3",
      "mercury-2",
      "grok-build-0.1",
      "owl-alpha",
      "gemini-3.5-flash",
      "qwen3.6-plus",
    ]) {
      expect(oss).not.toContain(`pi-${short}`);
    }
  });

  test("challengers (round 9) holds the pi variants of the strongest proprietary additions", () => {
    expect(CONFIG_PRESETS.find((p) => p.id === "challengers")?.configIds).toEqual([
      "pi-qwen3.7-max",
      "pi-minimax-m3",
      "pi-qwen3.7-plus",
      "pi-grok-4.3",
      "pi-mistral-medium-3.5",
    ]);
  });
});

describe("expandPresetSelection — CLI --preset expansion (v7.7 item 1)", () => {
  test("single preset expands to exactly its configIds", () => {
    expect(expandPresetSelection(["budget"], [])).toEqual([
      "claude-haiku",
      "pi-deepseek-flash",
      "pi-gemini-flash",
      "codex-5.6-luna",
    ]);
  });

  test("presets expand in flag order, then explicit ids; dedupe keeps first occurrence", () => {
    const out = expandPresetSelection(["budget", "frontier"], ["codex-5.4", "claude-haiku"]);
    expect(out).toEqual([
      // budget first (flag order)…
      "claude-haiku",
      "pi-deepseek-flash",
      "pi-gemini-flash",
      "codex-5.6-luna",
      // …then frontier minus nothing (no overlap with budget)…
      "claude-fable",
      "claude-opus",
      "claude-sonnet",
      "pi-deepseek-pro",
      "pi-gemini-pro",
      "pi-qwen3.7-max",
      "pi-minimax-m3",
      "codex-5.6-sol",
      // …then explicit --configs extras; the duplicate claude-haiku is dropped.
      "codex-5.4",
    ]);
  });

  test("overlapping presets dedupe across each other (oss ∩ frontier = pi-deepseek-pro)", () => {
    const out = expandPresetSelection(["frontier", "oss"], []);
    expect(out.filter((id) => id === "pi-deepseek-pro")).toHaveLength(1);
    expect(new Set(out).size).toBe(out.length);
  });

  test("unknown preset throws the frozen error before anything else", () => {
    expect(() => expandPresetSelection(["nope"], [])).toThrow(
      'unknown preset "nope" (available: frontier, challengers, oss, claude-family, budget, nightly-canary, weekly-matrix)',
    );
  });
});

// ---------------------------------------------------------------------------
// v8.0 (OutcomeSpec v2) — weighted graded dimension validation + serialization.
// ---------------------------------------------------------------------------
describe("validateScenario — OutcomeSpec v2 dimensions (v8.0)", () => {
  const okCheck = (name: string, weight?: number): DeterministicCheck => {
    const c: DeterministicCheck = { name, fn: async (): Promise<CheckResult> => ({ pass: true }) };
    if (weight !== undefined) c.weight = weight;
    return c;
  };
  const withDims = (dimensions: DimensionSpec[]) => scenario({ outcome: { dimensions } });

  test("a dimension with checks + positive weight is valid (core name)", () => {
    expect(
      validateScenario(withDims([{ name: "correctness", weight: 1, checks: [okCheck("c")] }])),
    ).toEqual([]);
  });

  test("a dimension with a judge + positive weight is valid", () => {
    expect(
      validateScenario(withDims([{ name: "communication", weight: 2, judge: { rubric: "r" } }])),
    ).toEqual([]);
  });

  test("custom dimension names are allowed (warn-only, not an error)", () => {
    expect(
      validateScenario(
        withDims([{ name: "retrieval-fidelity", weight: 1, judge: { rubric: "r" } }]),
      ),
    ).toEqual([]);
  });

  test("weight must be > 0", () => {
    expect(
      validateScenario(withDims([{ name: "correctness", weight: 0, checks: [okCheck("c")] }])),
    ).not.toEqual([]);
    expect(
      validateScenario(withDims([{ name: "correctness", weight: -1, checks: [okCheck("c")] }])),
    ).not.toEqual([]);
  });

  test("a dimension must define at least one of checks/judge", () => {
    expect(validateScenario(withDims([{ name: "correctness", weight: 1 }]))).not.toEqual([]);
    expect(
      validateScenario(withDims([{ name: "correctness", weight: 1, checks: [] }])),
    ).not.toEqual([]);
  });

  test("a non-efficiency dimension may NOT set both checks AND a judge (round 11 XOR)", () => {
    const errors = validateScenario(
      withDims([
        { name: "communication", weight: 1, checks: [okCheck("c")], judge: { rubric: "r" } },
      ]),
    );
    expect(errors).not.toEqual([]);
    expect(errors.join("\n")).toContain("EITHER checks OR a judge, not both");
    // The XOR rule is structural: checks-only and judge-only each stay valid.
    expect(
      validateScenario(withDims([{ name: "communication", weight: 1, checks: [okCheck("c")] }])),
    ).toEqual([]);
    expect(
      validateScenario(withDims([{ name: "communication", weight: 1, judge: { rubric: "r" } }])),
    ).toEqual([]);
  });

  test("dimension names must be unique within a scenario", () => {
    expect(
      validateScenario(
        withDims([
          { name: "correctness", weight: 1, checks: [okCheck("a")] },
          { name: "correctness", weight: 1, checks: [okCheck("b")] },
        ]),
      ),
    ).not.toEqual([]);
  });

  test("per-check weight must be > 0 when present", () => {
    expect(
      validateScenario(withDims([{ name: "correctness", weight: 1, checks: [okCheck("c", 0)] }])),
    ).not.toEqual([]);
    expect(
      validateScenario(withDims([{ name: "correctness", weight: 1, checks: [okCheck("c", 2)] }])),
    ).toEqual([]);
  });

  test("total dimension weight must be > 0 (guards Phase 3 divide-by-zero)", () => {
    // Each dim individually fails weight>0, so the total-weight error also fires.
    const errors = validateScenario(
      withDims([
        { name: "correctness", weight: 0, checks: [okCheck("a")] },
        { name: "completeness", weight: 0, checks: [okCheck("b")] },
      ]),
    );
    expect(errors.join("\n")).toContain("total weight must be > 0");
  });
});

describe("serializeScenario — OutcomeSpec v2 outcome view (v8.0)", () => {
  test("v1 spec normalizes: checks → gates, judge → correctness dimension, default 0.75", () => {
    const s = serializeScenario(
      scenario({
        outcome: {
          checks: [{ name: "k", fn: async () => ({ pass: true }) }],
          llmJudge: { rubric: "is it correct?" },
        },
      }),
    );
    expect(s.outcome.gates).toEqual(["k"]);
    expect(s.outcome.dimensions).toEqual([
      { name: "correctness", weight: 1, checks: [], judge: true },
    ]);
    // passThreshold now defaults via DEFAULT_PASS_THRESHOLD (0.75), not 0.7.
    expect(s.outcome.passThreshold).toBe(0.75);
    // legacy fields stay populated for back-compat UI.
    expect(s.outcome.llmJudge).not.toBeNull();
    expect(s.outcome.checks).toContain("tasks-completed");
  });

  test("v2 dimensions serialize names/weights/check-names/judge-flag", () => {
    const s = serializeScenario(
      scenario({
        outcome: {
          gates: [{ name: "g0", fn: async () => ({ pass: true }) }],
          dimensions: [
            {
              name: "correctness",
              weight: 3,
              checks: [{ name: "c0", fn: async () => ({ pass: true }) }],
            },
            { name: "communication", weight: 1, judge: { rubric: "grade comms" } },
          ],
        },
      }),
    );
    expect(s.outcome.gates).toEqual(["g0"]);
    expect(s.outcome.dimensions).toEqual([
      { name: "correctness", weight: 3, checks: ["c0"], judge: false },
      { name: "communication", weight: 1, checks: [], judge: true },
    ]);
  });
});

describe("serializeConfig — AA benchmark block (v7.6 item D)", () => {
  test("matched catalog config carries the joined aa block", () => {
    const s = serializeConfig({ id: "claude-fable", provider: "claude", model: "claude-fable-5" });
    expect(s.aa?.sourceRow).toBe("Claude Fable 5 (with fallback)");
    expect(s.aa?.intelligenceIndex).toBe(65);
    expect(s.aa?.provisional).toBe(false);
  });

  test("unmatched catalog config and non-catalog ids serialize aa as null", () => {
    expect(
      serializeConfig({ id: "claude-opus-4.6", provider: "claude", model: "claude-opus-4-6" }).aa,
    ).toBeNull();
    expect(serializeConfig({ id: "custom-x", provider: "claude" }).aa).toBeNull();
  });

  test("aa block is JSON-safe (no env values, survives a round-trip)", () => {
    const s = serializeConfig({ id: "pi-deepseek-flash", provider: "pi", model: "x" });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(s.aa?.medianTokensPerS).toBeNull(); // "--" cells stay null through the join
  });
});

// ---------------------------------------------------------------------------
// Round 10 (RUNNER-TOPO) — appended block. validateScenario dependsOn rules:
// forward refs legal, range/self/duplicate per-entry errors, whole-graph
// cycle detection naming the offending chain with indices + titles.
// ---------------------------------------------------------------------------
describe("validateScenario dependsOn (round 10 — relaxed range + cycle chain errors)", () => {
  const withDeps = (titles: string[], deps: { [i: number]: number[] }) =>
    scenario({
      tasks: titles.map((title, i) => ({ title, description: "d", dependsOn: deps[i] })),
    });

  test("chain, diamond, and independent roots are all valid", () => {
    expect(validateScenario(withDeps(["A", "B", "C"], { 1: [0], 2: [1] }))).toEqual([]);
    expect(validateScenario(withDeps(["A", "B", "C", "D"], { 1: [0], 2: [0], 3: [1, 2] }))).toEqual(
      [],
    );
    expect(validateScenario(withDeps(["A", "B", "C", "D"], { 2: [0], 3: [1] }))).toEqual([]);
  });

  test("acyclic forward reference is legal", () => {
    expect(validateScenario(withDeps(["A", "B", "C"], { 0: [2] }))).toEqual([]);
  });

  test("unknown ref keeps the frozen per-task error shape", () => {
    expect(validateScenario(withDeps(["A", "B", "C"], { 1: [5] }))).toEqual([
      'task 1 ("B"): dependsOn entry 5 must reference an existing task index [0, 2]',
    ]);
    expect(validateScenario(withDeps(["A", "B", "C"], { 2: [-1] }))).toEqual([
      'task 2 ("C"): dependsOn entry -1 must reference an existing task index [0, 2]',
    ]);
  });

  test("self-dependency gets its own explicit error (not the range error)", () => {
    expect(validateScenario(withDeps(["A", "B"], { 1: [1] }))).toEqual([
      'task 1 ("B"): dependsOn entry 1 is a self-dependency',
    ]);
  });

  test("dependency cycle names the chain with indices + titles (spec example)", () => {
    // 1 ("B") depends on 3 ("D") which depends back on 1 ("B").
    expect(validateScenario(withDeps(["A", "B", "C", "D"], { 1: [3], 3: [1] }))).toEqual([
      'dependency cycle: 1 ("B") → 3 ("D") → 1 ("B")',
    ]);
  });

  test("three-node cycle is named in DFS encounter order", () => {
    expect(validateScenario(withDeps(["A", "B", "C"], { 0: [1], 1: [2], 2: [0] }))).toEqual([
      'dependency cycle: 0 ("A") → 1 ("B") → 2 ("C") → 0 ("A")',
    ]);
  });

  test("duplicates and non-integers are still rejected alongside the relaxation", () => {
    const errors = validateScenario(withDeps(["A", "B", "C"], { 2: [0, 0] }));
    expect(errors).toEqual(['task 2 ("C"): duplicate dependsOn entry 0']);
    expect(validateScenario(withDeps(["A", "B"], { 1: [0.5] }))).toEqual([
      'task 1 ("B"): dependsOn entry 0.5 is not an integer',
    ]);
  });

  test("per-entry errors and cycle errors aggregate in one pass", () => {
    const errors = validateScenario(withDeps(["A", "B", "C"], { 0: [1, 9], 1: [0] }));
    expect(errors).toContain(
      'task 0 ("A"): dependsOn entry 9 must reference an existing task index [0, 2]',
    );
    expect(errors).toContain('dependency cycle: 0 ("A") → 1 ("B") → 0 ("A")');
  });
});

describe("validateScenario — member profiles, workerExec, humanInput (Phase 8)", () => {
  test("a declared profile, per-worker seeding and a canned human are valid together", () => {
    expect(
      validateScenario(
        scenario({
          workers: [
            { name: "a", profile: { role: "ops", capabilities: ["on-call"] } },
            { name: "b" },
          ],
          seed: { workerExec: [{ worker: 1, commands: ["true"] }] },
          humanInput: { reply: "EU only" },
          awaitSpawnedTasks: true,
        }),
      ),
    ).toEqual([]);
  });

  test("a profile must say something, within the API's limits", () => {
    expect(validateScenario(scenario({ workers: [{ profile: {} }] }))).toEqual([
      "workers[0].profile must set role, description or capabilities",
    ]);
    expect(
      validateScenario(
        scenario({ workers: [{ profile: { role: "x".repeat(101), capabilities: [" "] } }] }),
      ),
    ).toEqual([
      "workers[0].profile.role must be 1..100 chars",
      "workers[0].profile.capabilities entries must be non-empty strings",
    ]);
  });

  test("workerExec targets a booted worker and runs something", () => {
    expect(
      validateScenario(
        scenario({
          workers: 2,
          seed: {
            workerExec: [
              { worker: 2, commands: ["true"] },
              { worker: 0, commands: [] },
            ],
          },
        }),
      ),
    ).toEqual([
      "seed.workerExec[0].worker 2 out of range [0, 1]",
      "seed.workerExec[1].commands is empty",
    ]);
  });

  test("humanInput needs a reply and awaitSpawnedTasks (the answer is a follow-up task)", () => {
    expect(validateScenario(scenario({ humanInput: { reply: " " } }))).toEqual([
      "humanInput.reply must be non-empty",
      "humanInput requires awaitSpawnedTasks",
    ]);
  });
});

describe("scenario cards (Phase 6): every registered scenario says what it tests", () => {
  const TOPOLOGIES = ["single-agent", "swarm"];
  const FLOWS = ["parallel", "sequential"];
  const KINDS = ["regression", "capability"];

  test("every registered scenario has a card, and no card is orphaned", () => {
    const registered = scenarios.map((s) => s.id).sort();
    expect(Object.keys(SCENARIO_CARDS).sort()).toEqual(registered);
  });

  test("summary, agentDoes and scoredBy are real sentences, not placeholders", () => {
    for (const s of scenarios) {
      const card = scenarioCard(s.id);
      expect(card, s.id).not.toBeNull();
      for (const field of ["summary", "agentDoes", "scoredBy"] as const) {
        const text = card?.[field] ?? "";
        expect(text.trim().length, `${s.id}.${field}`).toBeGreaterThanOrEqual(40);
        expect(text, `${s.id}.${field}`).not.toMatch(/\b(TODO|TBD|FIXME)\b/);
      }
    }
  });

  test("tags carry one value from each axis", () => {
    for (const s of scenarios) {
      const tags = scenarioCard(s.id)?.tags;
      expect(TOPOLOGIES, s.id).toContain(tags?.topology ?? "");
      expect(FLOWS, s.id).toContain(tags?.flow ?? "");
      expect(KINDS, s.id).toContain(tags?.kind ?? "");
    }
  });

  test("the topology tag matches the roster: a lead or several workers is a swarm", () => {
    for (const s of scenarios) {
      const isSwarm = s.lead !== undefined || scenarioWorkerCount(s.workers) > 1;
      expect(scenarioCard(s.id)?.tags.topology, s.id).toBe(isSwarm ? "swarm" : "single-agent");
    }
  });

  test("a solo baseline is a single-agent scenario", () => {
    for (const s of scenarios.filter((x) => x.baselineOf !== undefined)) {
      expect(scenarioCard(s.id)?.tags.topology, s.id).toBe("single-agent");
    }
  });

  test("the changelog has one line per pinned version, so a bump cannot skip the card", () => {
    for (const s of scenarios) {
      const pinned = (SCENARIO_HASHES[s.id] ?? []).map((h) => h.version);
      const noted = (scenarioCard(s.id)?.changelog ?? []).map((c) => c.version);
      expect(noted, s.id).toEqual(pinned);
      expect(noted.at(-1), s.id).toBe(s.version);
      for (const entry of scenarioCard(s.id)?.changelog ?? []) {
        expect(entry.note.trim().length, `${s.id} v${entry.version}`).toBeGreaterThan(0);
      }
    }
  });

  test("serializeScenario carries the card and the suite it belongs to", () => {
    const sql = scenarios.find((s) => s.id === "sql-audit") as Scenario;
    const j = serializeScenario(sql);
    expect(j.card).toEqual(scenarioCard("sql-audit"));
    expect(j.suite).toBe("swarm-evals@1.0");
    // A scenario outside the manifest (or at another version) has no suite.
    expect(serializeScenario(scenario({ id: "sql-audit", version: 99 })).suite).toBeNull();
    expect(serializeScenario(scenario({ id: "not-registered" })).card).toBeNull();
  });
});
