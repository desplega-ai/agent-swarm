import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDb, initDb, resetDbForTests } from "../db/client.ts";
import { createRun } from "../db/queries.ts";
import type { HarnessConfig, Scenario } from "../types.ts";
import type { Registry } from "./index.ts";
import {
  applyRunConfigPins,
  assertRunConfigsResolve,
  ensureRunConfigPins,
  referencedConfigIds,
} from "./run-configs.ts";

const ENV_KEYS = ["EVALS_DB_SYNC_URL", "EVALS_DB_AUTH_TOKEN", "EVALS_DB_PATH"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const opus: HarnessConfig = {
  id: "claude-opus",
  provider: "claude",
  modelAlias: "latest:anthropic/opus",
};
const pinned: HarnessConfig = {
  id: "claude-opus-4.8",
  provider: "claude",
  model: "claude-opus-4-8",
};
const flash: HarnessConfig = {
  id: "pi-latest-deepseek-v4",
  provider: "pi",
  modelAlias: "latest:openrouter/deepseek/deepseek-v4*-flash",
};
const broken: HarnessConfig = {
  id: "pi-nothing",
  provider: "pi",
  modelAlias: "latest:openrouter/nope/*",
};

const scenario = {
  id: "s1",
  name: "s1",
  workers: [{ configId: "pi-latest-deepseek-v4" }],
  tasks: [],
  outcome: {},
} as unknown as Scenario;

const registry: Registry = {
  scenarios: new Map([["s1", scenario]]),
  configs: new Map([opus, pinned, flash, broken].map((c) => [c.id, c])),
};

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

describe("run config pins", () => {
  test("member configIds count as referenced", () => {
    expect(referencedConfigIds(registry, ["s1"], ["claude-opus"]).sort()).toEqual([
      "claude-opus",
      "pi-latest-deepseek-v4",
    ]);
  });

  test("pins every referenced alias once and applies the concrete model", async () => {
    const db = getDb();
    await createRun(db, {
      id: "run-a",
      scenarioIds: ["s1"],
      configIds: ["claude-opus", "claude-opus-4.8"],
      attemptsPerCell: 1,
      concurrency: 1,
    });
    const pins = await ensureRunConfigPins(
      db,
      "run-a",
      registry,
      ["s1"],
      ["claude-opus", "claude-opus-4.8"],
    );
    expect([...pins.keys()].sort()).toEqual(["claude-opus", "pi-latest-deepseek-v4"]);
    expect(pins.get("claude-opus")?.resolvedModel).toMatch(/^claude-opus-/);
    expect(pins.get("pi-latest-deepseek-v4")?.resolvedModel).toMatch(/^openrouter\/deepseek\//);

    // A later resolution never overwrites the stored pin.
    await db.execute(
      "UPDATE eval_run_configs SET resolved_model = 'claude-opus-0' WHERE config_id = 'claude-opus'",
    );
    const again = await ensureRunConfigPins(db, "run-a", registry, ["s1"], ["claude-opus"]);
    expect(again.get("claude-opus")?.resolvedModel).toBe("claude-opus-0");

    const applied = applyRunConfigPins(registry, again);
    expect(applied.configs.get("claude-opus")?.model).toBe("claude-opus-0");
    expect(applied.configs.get("claude-opus-4.8")).toBe(pinned);
  });

  test("an unresolvable alias fails before the run is created", async () => {
    await expect(assertRunConfigsResolve(registry, [], ["pi-nothing"])).rejects.toThrow(
      "pi-nothing (latest:openrouter/nope/*)",
    );
    await expect(
      assertRunConfigsResolve(registry, ["s1"], ["claude-opus"]),
    ).resolves.toBeUndefined();
  });
});
