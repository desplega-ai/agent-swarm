import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, initDb } from "../be/db";

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

  test("pricing CHECKs are dropped — accepts every provider in the new Zod enum", () => {
    const stmt = getDb().prepare(
      `INSERT INTO pricing (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, 0, 1.0, 0, 0)`,
    );

    for (const provider of [
      "claude",
      "claude-managed",
      "codex",
      "pi",
      "opencode",
      "devin",
      "gemini",
    ]) {
      expect(() => stmt.run(provider, "test-model", "input")).not.toThrow();
    }

    for (const tokenClass of [
      "input",
      "cached_input",
      "output",
      "cache_write",
      "runtime_hour",
      "acu",
    ]) {
      expect(() => stmt.run("claude-managed", "mm", tokenClass)).not.toThrow();
    }
  });

  test("agent_tasks.totalContextTokensUsed renamed to peakContextTokens", () => {
    const cols = getDb()
      .prepare<{ name: string }, []>("PRAGMA table_info(agent_tasks)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("peakContextTokens")).toBe(true);
    expect(names.has("totalContextTokensUsed")).toBe(false);
  });

  test("task_context_snapshots has contextFormula column", () => {
    const cols = getDb()
      .prepare<{ name: string }, []>("PRAGMA table_info(task_context_snapshots)")
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "contextFormula")).toBe(true);
  });

  test("session_costs has reasoningOutputTokens + thinkingTokens", () => {
    const cols = getDb()
      .prepare<{ name: string; dflt_value: string | null }, []>("PRAGMA table_info(session_costs)")
      .all() as Array<{ name: string; dflt_value: string | null }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has("reasoningOutputTokens")).toBe(true);
    expect(byName.has("thinkingTokens")).toBe(true);
    expect(byName.get("reasoningOutputTokens")?.dflt_value).toBe("0");
    expect(byName.get("thinkingTokens")?.dflt_value).toBe("0");
  });

  test("session_costs.costSource CHECK is dropped — accepts 'unpriced'", () => {
    // Insert a row using the relaxed costSource. We use a raw INSERT (no FKs)
    // so we don't have to seed agents/tasks. Disable FK enforcement for the
    // test since we don't care about referential integrity here.
    getDb().exec("PRAGMA foreign_keys = OFF");
    const stmt = getDb().prepare(
      `INSERT INTO session_costs
        (id, sessionId, taskId, agentId, totalCostUsd, durationMs, numTurns, model, costSource, createdAt)
       VALUES (?, ?, NULL, ?, 0, 0, NULL, 'm', ?, '2026-05-15T00:00:00.000Z')`,
    );
    expect(() => stmt.run(crypto.randomUUID(), "s", "a", "unpriced")).not.toThrow();
    getDb().exec("PRAGMA foreign_keys = ON");
  });

  test("session_costs.numTurns and cacheWriteTokens are nullable", () => {
    const cols = getDb()
      .prepare<{ name: string; notnull: number }, []>("PRAGMA table_info(session_costs)")
      .all() as Array<{ name: string; notnull: number }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("numTurns")?.notnull).toBe(0);
    expect(byName.get("cacheWriteTokens")?.notnull).toBe(0);
  });
});
