import { describe, expect, test } from "bun:test";
import { configs } from "../configs/index.ts";
import { CONFIG_PRESETS, expandPresetSelection } from "../configs/presets.ts";
import { serializeConfig, serializeScenario, validateScenario } from "./registry.ts";
import type { Scenario } from "./types.ts";

/** Minimal valid scenario; tests override single fields to isolate one rule. */
function scenario(overrides: Partial<Scenario>): Scenario {
  return {
    id: "test-scenario",
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

  describe("dependsOn rules (strictly-earlier-index = the cycle check)", () => {
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

    test("forward reference rejected", () => {
      expect(validateScenario(tasks3({ 1: [2] }))).not.toEqual([]);
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
  test("display order is frozen: frontier, oss, claude-family, budget", () => {
    expect(CONFIG_PRESETS.map((p) => p.id)).toEqual(["frontier", "oss", "claude-family", "budget"]);
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

  test("oss carries the round-8 OSS refresh pi/opencode twins", () => {
    const oss = CONFIG_PRESETS.find((p) => p.id === "oss")?.configIds ?? [];
    for (const short of [
      "kimi-k2.6",
      "glm-5.1",
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "nemotron-3-ultra",
    ]) {
      expect(oss).toContain(`pi-${short}`);
      expect(oss).toContain(`opencode-${short}`);
    }
    // Pre-refresh members stay (historical runs reference them).
    for (const id of ["pi-kimi-k2.5", "pi-minimax-m2.5", "opencode-kimi-k2.5"]) {
      expect(oss).toContain(id);
    }
  });
});

describe("expandPresetSelection — CLI --preset expansion (v7.7 item 1)", () => {
  test("single preset expands to exactly its configIds", () => {
    expect(expandPresetSelection(["budget"], [])).toEqual([
      "claude-haiku",
      "pi-deepseek-flash",
      "pi-gemini-flash",
      "codex-5.4-mini",
    ]);
  });

  test("presets expand in flag order, then explicit ids; dedupe keeps first occurrence", () => {
    const out = expandPresetSelection(["budget", "frontier"], ["codex-5.4", "claude-haiku"]);
    expect(out).toEqual([
      // budget first (flag order)…
      "claude-haiku",
      "pi-deepseek-flash",
      "pi-gemini-flash",
      "codex-5.4-mini",
      // …then frontier minus nothing (no overlap with budget)…
      "claude-fable",
      "claude-opus",
      "claude-sonnet",
      "pi-deepseek-pro",
      "pi-gemini-pro",
      "codex-5.5",
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
      'unknown preset "nope" (available: frontier, oss, claude-family, budget)',
    );
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
