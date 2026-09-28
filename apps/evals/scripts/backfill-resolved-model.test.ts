import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDb, initDb, resetDbForTests } from "../src/db/client.ts";
import { createRun, insertAttempt } from "../src/db/queries.ts";
import type { HarnessConfig } from "../src/types.ts";
import { applyBackfill, loadBackfillRows, planBackfill } from "./backfill-resolved-model.ts";

const configs = new Map<string, HarnessConfig>([
  ["pi-flash", { id: "pi-flash", provider: "pi", model: "openrouter/deepseek/deepseek-v4-flash" }],
  ["claude-opus", { id: "claude-opus", provider: "claude", modelAlias: "latest:anthropic/opus" }],
  ["claude-bare", { id: "claude-bare", provider: "claude", model: "opus" }],
]);

describe("planBackfill", () => {
  test("tokens first, then pinned config model on graded rows; bare aliases stay NULL", () => {
    const updates = planBackfill(
      [
        { id: "a", configId: "claude-opus", status: "passed", tokenModel: "claude-opus-5-5" },
        { id: "b", configId: "pi-flash", status: "failed", tokenModel: null },
        { id: "c", configId: "pi-flash", status: "error", tokenModel: null },
        { id: "d", configId: "claude-opus", status: "passed", tokenModel: null },
        { id: "e", configId: "claude-bare", status: "passed", tokenModel: "opus" },
        { id: "f", configId: "gone", status: "passed", tokenModel: null },
      ],
      configs,
    );
    expect(updates).toEqual([
      { id: "a", resolvedModel: "claude-opus-5-5", source: "tokens" },
      { id: "b", resolvedModel: "openrouter/deepseek/deepseek-v4-flash", source: "config" },
    ]);
  });
});

const ENV_KEYS = ["EVALS_DB_SYNC_URL", "EVALS_DB_AUTH_TOKEN", "EVALS_DB_PATH"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

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

describe("backfill against a DB", () => {
  test("second run is a no-op", async () => {
    const db = getDb();
    await createRun(db, {
      id: "r",
      scenarioIds: ["s"],
      configIds: ["pi-flash"],
      attemptsPerCell: 1,
      concurrency: 1,
    });
    await insertAttempt(db, {
      id: "a1",
      runId: "r",
      scenarioId: "s",
      configId: "pi-flash",
      attemptIndex: 0,
    });
    await db.execute("UPDATE attempts SET status = 'passed' WHERE id = 'a1'");
    const first = planBackfill(await loadBackfillRows(db), configs);
    expect(await applyBackfill(db, first)).toBe(1);
    const second = planBackfill(await loadBackfillRows(db), configs);
    expect(second).toEqual([]);
    expect(await applyBackfill(db, first)).toBe(0);
  });
});
