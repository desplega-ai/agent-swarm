import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getResolutionCatalog } from "../cost/catalog.ts";
import { initDb, resetDbForTests } from "../db/client.ts";
import { createRun, getAttempt, getRun, insertAttempt, updateAttempt } from "../db/queries.ts";
import type { HarnessConfig, Scenario } from "../types.ts";
import type { Registry } from "./index.ts";
import { applyRunEfforts, parseEffortOverrides, planRunEfforts } from "./run-efforts.ts";

const ENV_KEYS = ["EVALS_DB_SYNC_URL", "EVALS_DB_AUTH_TOKEN", "EVALS_DB_PATH"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const catalog = await getResolutionCatalog();

const haiku: HarnessConfig = {
  id: "claude-haiku",
  provider: "claude",
  model: "claude-haiku-4-5",
  reasoningEffort: "low",
};
const sol: HarnessConfig = { id: "codex-sol", provider: "codex", model: "gpt-5.6-sol" };
const flash: HarnessConfig = {
  id: "pi-deepseek-flash",
  provider: "pi",
  model: "openrouter/deepseek/deepseek-v4-flash",
};
const harnessDefault: HarnessConfig = { id: "claude-default", provider: "claude" };

const scenario = {
  id: "s1",
  name: "s1",
  workers: [{ configId: "pi-deepseek-flash" }],
  tasks: [],
  outcome: {},
} as unknown as Scenario;

const registry: Registry = {
  scenarios: new Map([["s1", scenario]]),
  configs: new Map([haiku, sol, flash, harnessDefault].map((c) => [c.id, c])),
};

const plan = (configIds: string[], overrides?: Parameters<typeof planRunEfforts>[0]["overrides"]) =>
  planRunEfforts({ registry, scenarioIds: ["s1"], configIds, overrides, catalog });

beforeEach(async () => {
  resetDbForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
  await initDb();
});

afterEach(() => {
  resetDbForTests();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("parseEffortOverrides", () => {
  test("keeps levels, turns null and empty into the harness default", () => {
    expect(parseEffortOverrides({ a: "high", b: null, c: "" })).toEqual({
      a: "high",
      b: null,
      c: null,
    });
    expect(parseEffortOverrides(undefined)).toEqual({});
    expect(parseEffortOverrides(null)).toEqual({});
  });

  test("rejects a non-object and an unknown level", () => {
    expect(() => parseEffortOverrides(["high"])).toThrow("object of configId");
    expect(() => parseEffortOverrides("high")).toThrow("object of configId");
    expect(() => parseEffortOverrides({ a: "ultra" })).toThrow('efforts["a"]');
  });
});

describe("planRunEfforts", () => {
  test("a config's default effort is the run's effort", () => {
    expect(plan(["claude-haiku"])).toEqual({ "claude-haiku": "low" });
  });

  test("a per-run override beats the default; null runs the config at the harness default", () => {
    expect(plan(["claude-haiku"], { "claude-haiku": "high" })).toEqual({
      "claude-haiku": "high",
    });
    expect(plan(["claude-haiku"], { "claude-haiku": null })).toEqual({});
  });

  test("configs with no effort are absent; an override can set one on them", () => {
    expect(plan(["codex-sol", "claude-default"])).toEqual({});
    expect(plan(["codex-sol"], { "codex-sol": "max" })).toEqual({ "codex-sol": "max" });
  });

  test("a level the pair does not take is refused, naming every offender", () => {
    expect(() => plan(["claude-haiku"], { "claude-haiku": "max" })).toThrow(
      /claude-haiku: claude \+ claude-haiku-4-5 does not take effort "max"/,
    );
    let message = "";
    try {
      plan(["claude-haiku", "claude-default"], { "claude-haiku": "max", "claude-default": "high" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("claude-haiku:");
    expect(message).toContain("claude-default: config claude-default runs the harness default");
  });

  test("an override for a config outside the run is refused", () => {
    expect(() => plan(["claude-haiku"], { "codex-sol": "high" })).toThrow(
      'effort override for "codex-sol": config is not in this run',
    );
  });

  test("a config a scenario member references is planned too, from its default", () => {
    const withDefault: Registry = {
      ...registry,
      configs: new Map([...registry.configs, [flash.id, { ...flash, reasoningEffort: "high" }]]),
    };
    expect(
      planRunEfforts({
        registry: withDefault,
        scenarioIds: ["s1"],
        configIds: ["codex-sol"],
        catalog,
      }),
    ).toEqual({ "pi-deepseek-flash": "high" });
  });
});

describe("applyRunEfforts", () => {
  test("configs carry exactly the snapshot: it wins over the default and drops a default it omits", () => {
    const applied = applyRunEfforts(registry, { "codex-sol": "xhigh" });
    expect(applied.configs.get("codex-sol")?.reasoningEffort).toBe("xhigh");
    // haiku has default "low" but the snapshot omits it, so the run does not use it
    expect(applied.configs.get("claude-haiku")?.reasoningEffort).toBeUndefined();
    expect(applied.configs.get("claude-haiku")?.model).toBe("claude-haiku-4-5");
    // the source registry is untouched
    expect(registry.configs.get("claude-haiku")?.reasoningEffort).toBe("low");
  });

  test("a run created before efforts existed (null snapshot) runs every config at its harness default", () => {
    for (const efforts of [null, undefined]) {
      const applied = applyRunEfforts(registry, efforts);
      expect(applied.configs.get("claude-haiku")?.reasoningEffort).toBeUndefined();
    }
  });
});

describe("effort persistence", () => {
  test("a run stores its snapshot; a legacy run row reads back null", async () => {
    const db = await initDb();
    await createRun(db, {
      id: "run-new",
      scenarioIds: ["s1"],
      configIds: ["claude-haiku"],
      attemptsPerCell: 1,
      concurrency: 1,
      efforts: { "claude-haiku": "low" },
    });
    expect((await getRun(db, "run-new"))?.efforts).toEqual({ "claude-haiku": "low" });

    await createRun(db, {
      id: "run-none",
      scenarioIds: ["s1"],
      configIds: ["claude-haiku"],
      attemptsPerCell: 1,
      concurrency: 1,
    });
    expect((await getRun(db, "run-none"))?.efforts).toEqual({});

    await db.execute({
      sql: `INSERT INTO eval_runs (id, scenario_ids, config_ids) VALUES ('run-legacy', '[]', '[]')`,
      args: [],
    });
    expect((await getRun(db, "run-legacy"))?.efforts).toBeNull();
  });

  test("an attempt records the launched and the applied effort; a retry can reset both", async () => {
    const db = await initDb();
    await createRun(db, {
      id: "run-a",
      scenarioIds: ["s1"],
      configIds: ["claude-haiku"],
      attemptsPerCell: 1,
      concurrency: 1,
    });
    await insertAttempt(db, {
      id: "att-1",
      runId: "run-a",
      scenarioId: "s1",
      configId: "claude-haiku",
      attemptIndex: 0,
    });
    expect((await getAttempt(db, "att-1"))?.reasoningEffort).toBeNull();
    await updateAttempt(db, "att-1", { reasoningEffort: "low", appliedReasoningEffort: "low" });
    const stored = await getAttempt(db, "att-1");
    expect(stored?.reasoningEffort).toBe("low");
    expect(stored?.appliedReasoningEffort).toBe("low");
    await updateAttempt(db, "att-1", { reasoningEffort: "low", appliedReasoningEffort: null });
    expect((await getAttempt(db, "att-1"))?.appliedReasoningEffort).toBeNull();
  });
});
