import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb } from "../be/db";

const TEST_DB_PATH = "./test-migration-063.sqlite";

describe("Migration 063 — cost & context schema relax", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // doesn't exist
      }
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // ignore
      }
    }
  });

  test("pricing CHECKs are dropped — accepts every provider in the new Zod enum", async () => {
    const sql = `INSERT INTO pricing (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, 0, 1.0, 0, 0)`;

    for (const provider of [
      "claude",
      "claude-managed",
      "codex",
      "pi",
      "opencode",
      "devin",
      "gemini",
    ]) {
      await expect(
        getDbClient().run(sql, [provider, "test-model", "input"]),
      ).resolves.not.toBeNull();
    }

    for (const tokenClass of [
      "input",
      "cached_input",
      "output",
      "cache_write",
      "runtime_hour",
      "acu",
    ]) {
      await expect(
        getDbClient().run(sql, ["claude-managed", "mm", tokenClass]),
      ).resolves.not.toBeNull();
    }
  });

  test("agent_tasks.totalContextTokensUsed renamed to peakContextTokens", async () => {
    const cols = await getDbClient().query<{ name: string }>("PRAGMA table_info(agent_tasks)");
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("peakContextTokens")).toBe(true);
    expect(names.has("totalContextTokensUsed")).toBe(false);
  });

  test("task_context_snapshots has contextFormula column", async () => {
    const cols = await getDbClient().query<{ name: string }>(
      "PRAGMA table_info(task_context_snapshots)",
    );
    expect(cols.some((c) => c.name === "contextFormula")).toBe(true);
  });

  test("session_costs has reasoningOutputTokens + thinkingTokens", async () => {
    const cols = await getDbClient().query<{ name: string; dflt_value: string | null }>(
      "PRAGMA table_info(session_costs)",
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has("reasoningOutputTokens")).toBe(true);
    expect(byName.has("thinkingTokens")).toBe(true);
    expect(byName.get("reasoningOutputTokens")?.dflt_value).toBe("0");
    expect(byName.get("thinkingTokens")?.dflt_value).toBe("0");
  });

  test("session_costs.costSource CHECK is dropped — accepts 'unpriced'", async () => {
    // Insert a row using the relaxed costSource. We use a raw INSERT (no FKs)
    // so we don't have to seed agents/tasks. Disable FK enforcement for the
    // test since we don't care about referential integrity here.
    await getDbClient().run("PRAGMA foreign_keys = OFF");
    const sql = `INSERT INTO session_costs
        (id, sessionId, taskId, agentId, totalCostUsd, durationMs, numTurns, model, costSource, createdAt)
       VALUES (?, ?, NULL, ?, 0, 0, NULL, 'm', ?, '2026-05-15T00:00:00.000Z')`;
    await expect(
      getDbClient().run(sql, [crypto.randomUUID(), "s", "a", "unpriced"]),
    ).resolves.not.toBeNull();
    await getDbClient().run("PRAGMA foreign_keys = ON");
  });

  test("session_costs.numTurns and cacheWriteTokens are nullable", async () => {
    const cols = await getDbClient().query<{ name: string; notnull: number }>(
      "PRAGMA table_info(session_costs)",
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("numTurns")?.notnull).toBe(0);
    expect(byName.get("cacheWriteTokens")?.notnull).toBe(0);
  });
});
