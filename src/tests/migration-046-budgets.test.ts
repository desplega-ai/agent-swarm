import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, initDb } from "../be/db";
import { CODEX_MODEL_PRICING } from "../providers/codex-models";

const TEST_DB_PATH = "./test-migration-046.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface MasterRow {
  sql: string;
  name: string;
}

interface CountRow {
  cnt: number;
}

interface PricingRow {
  provider: string;
  model: string;
  token_class: string;
  effective_from: number;
  price_per_million_usd: number;
  createdAt: number;
  lastUpdatedAt: number;
}

describe("migration 046 — budgets and pricing", () => {
  test("budgets table exists with expected columns and PK", () => {
    const db = getDb();
    const cols = db.prepare<TableInfoRow, []>("PRAGMA table_info(budgets)").all();
    expect(cols.length).toBeGreaterThan(0);

    const colMap = new Map(cols.map((c) => [c.name, c]));
    expect(colMap.has("scope")).toBe(true);
    expect(colMap.has("scope_id")).toBe(true);
    expect(colMap.has("daily_budget_usd")).toBe(true);
    expect(colMap.has("createdAt")).toBe(true);
    expect(colMap.has("lastUpdatedAt")).toBe(true);

    // Composite PK on (scope, scope_id) — both pk fields > 0.
    expect(colMap.get("scope")!.pk).toBeGreaterThan(0);
    expect(colMap.get("scope_id")!.pk).toBeGreaterThan(0);
  });

  test("budgets CHECK constraints reject invalid scope and negative budget", () => {
    const db = getDb();
    // Valid global row.
    db.prepare(
      "INSERT INTO budgets (scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?)",
    ).run("global", "", 10.0, 0, 0);

    // Round-trip
    const row = db
      .prepare<{ scope: string; scope_id: string; daily_budget_usd: number }, []>(
        "SELECT scope, scope_id, daily_budget_usd FROM budgets WHERE scope = 'global'",
      )
      .get();
    expect(row?.scope).toBe("global");
    expect(row?.scope_id).toBe("");
    expect(row?.daily_budget_usd).toBe(10.0);

    // Inserting another row with same PK fails.
    expect(() =>
      db
        .prepare(
          "INSERT INTO budgets (scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?)",
        )
        .run("global", "", 5.0, 0, 0),
    ).toThrow();

    // Invalid scope rejected by CHECK.
    expect(() =>
      db
        .prepare(
          "INSERT INTO budgets (scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?)",
        )
        .run("not-a-scope", "x", 1.0, 0, 0),
    ).toThrow();

    // Negative budget rejected by CHECK.
    expect(() =>
      db
        .prepare(
          "INSERT INTO budgets (scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?)",
        )
        .run("agent", "agent-x", -1, 0, 0),
    ).toThrow();
  });

  test("pricing table exists with expected columns and composite PK", () => {
    const db = getDb();
    const cols = db.prepare<TableInfoRow, []>("PRAGMA table_info(pricing)").all();
    expect(cols.length).toBeGreaterThan(0);

    const colMap = new Map(cols.map((c) => [c.name, c]));
    expect(colMap.has("provider")).toBe(true);
    expect(colMap.has("model")).toBe(true);
    expect(colMap.has("token_class")).toBe(true);
    expect(colMap.has("effective_from")).toBe(true);
    expect(colMap.has("price_per_million_usd")).toBe(true);

    // All four PK columns participate in the composite PK.
    expect(colMap.get("provider")!.pk).toBeGreaterThan(0);
    expect(colMap.get("model")!.pk).toBeGreaterThan(0);
    expect(colMap.get("token_class")!.pk).toBeGreaterThan(0);
    expect(colMap.get("effective_from")!.pk).toBeGreaterThan(0);
  });

  test("pricing seed has exactly 12 rows (4 models × 3 token_classes), all at effective_from=0", () => {
    const db = getDb();
    const total = db.prepare<CountRow, []>("SELECT COUNT(*) as cnt FROM pricing").get();
    expect(total?.cnt).toBe(12);

    const seedRows = db
      .prepare<CountRow, []>("SELECT COUNT(*) as cnt FROM pricing WHERE effective_from = 0")
      .get();
    expect(seedRows?.cnt).toBe(12);
  });

  test("every CODEX_MODEL_PRICING entry has rows for input / cached_input / output with matching rates", () => {
    const db = getDb();

    for (const [model, pricing] of Object.entries(CODEX_MODEL_PRICING)) {
      const inputRow = db
        .prepare<PricingRow, [string, string, number]>(
          "SELECT * FROM pricing WHERE provider = 'codex' AND model = ? AND token_class = ? AND effective_from = ?",
        )
        .get(model, "input", 0);
      expect(inputRow?.price_per_million_usd).toBe(pricing.inputPerMillion);

      const cachedRow = db
        .prepare<PricingRow, [string, string, number]>(
          "SELECT * FROM pricing WHERE provider = 'codex' AND model = ? AND token_class = ? AND effective_from = ?",
        )
        .get(model, "cached_input", 0);
      expect(cachedRow?.price_per_million_usd).toBe(pricing.cachedInputPerMillion);

      const outputRow = db
        .prepare<PricingRow, [string, string, number]>(
          "SELECT * FROM pricing WHERE provider = 'codex' AND model = ? AND token_class = ? AND effective_from = ?",
        )
        .get(model, "output", 0);
      expect(outputRow?.price_per_million_usd).toBe(pricing.outputPerMillion);
    }
  });

  test("idx_pricing_lookup index exists", () => {
    const db = getDb();
    const idx = db
      .prepare<MasterRow, []>(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_pricing_lookup'",
      )
      .get();
    expect(idx?.name).toBe("idx_pricing_lookup");
    expect(idx?.sql).toContain("provider");
    expect(idx?.sql).toContain("model");
    expect(idx?.sql).toContain("token_class");
    expect(idx?.sql).toContain("effective_from");
  });

  test("re-applying seed INSERT OR IGNORE does not duplicate rows", () => {
    const db = getDb();
    const before = db.prepare<CountRow, []>("SELECT COUNT(*) as cnt FROM pricing").get();

    // Replay the same seed statements.
    db.prepare(
      `INSERT OR IGNORE INTO pricing (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
       VALUES ('codex', 'gpt-5.4', 'input', 0, 2.5, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO pricing (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
       VALUES ('codex', 'gpt-5.3-codex', 'output', 0, 14.0, 0, 0)`,
    ).run();

    const after = db.prepare<CountRow, []>("SELECT COUNT(*) as cnt FROM pricing").get();
    expect(after?.cnt).toBe(before?.cnt);
  });

  test("append-only price history: new effective_from row coexists with seed; latest-active lookup picks correct row", () => {
    const db = getDb();
    const NOW = 1_700_000_000_000; // arbitrary epoch ms in the future relative to 0

    // Add a NEW pricing row for codex/gpt-5.3-codex/input at a later effective_from with a different price.
    db.prepare(
      `INSERT INTO pricing (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
       VALUES ('codex', 'gpt-5.3-codex', 'input', ?, ?, ?, ?)`,
    ).run(NOW, 99.99, NOW, NOW);

    // Seed row should still exist at effective_from = 0.
    const seedRow = db
      .prepare<PricingRow, []>(
        "SELECT * FROM pricing WHERE provider='codex' AND model='gpt-5.3-codex' AND token_class='input' AND effective_from=0",
      )
      .get();
    expect(seedRow?.price_per_million_usd).toBe(1.75);

    // "Largest effective_from <= now" — should return the new row.
    const latestRow = db
      .prepare<PricingRow, [number]>(
        `SELECT * FROM pricing
         WHERE provider='codex' AND model='gpt-5.3-codex' AND token_class='input'
         AND effective_from <= ?
         ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(NOW + 1);
    expect(latestRow?.effective_from).toBe(NOW);
    expect(latestRow?.price_per_million_usd).toBe(99.99);

    // Same query against effective_from <= 0 should return the seed row.
    const seedLookup = db
      .prepare<PricingRow, [number]>(
        `SELECT * FROM pricing
         WHERE provider='codex' AND model='gpt-5.3-codex' AND token_class='input'
         AND effective_from <= ?
         ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(0);
    expect(seedLookup?.effective_from).toBe(0);
    expect(seedLookup?.price_per_million_usd).toBe(1.75);
  });

  test("budget_refusal_notifications table exists with expected columns and composite PK", () => {
    const db = getDb();
    const cols = db
      .prepare<TableInfoRow, []>("PRAGMA table_info(budget_refusal_notifications)")
      .all();
    expect(cols.length).toBeGreaterThan(0);

    const colMap = new Map(cols.map((c) => [c.name, c]));
    expect(colMap.has("task_id")).toBe(true);
    expect(colMap.has("date")).toBe(true);
    expect(colMap.has("agent_id")).toBe(true);
    expect(colMap.has("cause")).toBe(true);
    expect(colMap.has("agent_spend_usd")).toBe(true);
    expect(colMap.has("agent_budget_usd")).toBe(true);
    expect(colMap.has("global_spend_usd")).toBe(true);
    expect(colMap.has("global_budget_usd")).toBe(true);
    expect(colMap.has("follow_up_task_id")).toBe(true);
    expect(colMap.has("createdAt")).toBe(true);

    // Composite PK on (task_id, date).
    expect(colMap.get("task_id")!.pk).toBeGreaterThan(0);
    expect(colMap.get("date")!.pk).toBeGreaterThan(0);

    // Optional spend/budget fields are NULL-able.
    expect(colMap.get("agent_spend_usd")!.notnull).toBe(0);
    expect(colMap.get("global_budget_usd")!.notnull).toBe(0);
    expect(colMap.get("follow_up_task_id")!.notnull).toBe(0);
  });

  test("budget_refusal_notifications dedup via INSERT OR IGNORE on (task_id, date)", () => {
    const db = getDb();

    const taskId = "task-dedup-1";
    const date = "2026-04-28";

    const first = db
      .prepare(
        `INSERT OR IGNORE INTO budget_refusal_notifications
         (task_id, date, agent_id, cause, createdAt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(taskId, date, "agent-1", "agent", 0);
    expect(first.changes).toBe(1);

    // Second insert with same PK is silently ignored.
    const second = db
      .prepare(
        `INSERT OR IGNORE INTO budget_refusal_notifications
         (task_id, date, agent_id, cause, createdAt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(taskId, date, "agent-1", "agent", 1);
    expect(second.changes).toBe(0);

    // Different date succeeds (PK rolls over).
    const nextDay = db
      .prepare(
        `INSERT OR IGNORE INTO budget_refusal_notifications
         (task_id, date, agent_id, cause, createdAt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(taskId, "2026-04-29", "agent-1", "agent", 2);
    expect(nextDay.changes).toBe(1);
  });

  test("budget_refusal_notifications CHECK rejects unknown cause", () => {
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO budget_refusal_notifications
           (task_id, date, agent_id, cause, createdAt)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("task-cause-1", "2026-04-28", "agent-1", "not-a-cause", 0),
    ).toThrow();
  });
});
