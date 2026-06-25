import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getActivePricingRow, getDb, getLogsByEventType, initDb } from "../be/db";
import type { ModelsDevCache } from "../be/modelsdev-cache";
import { refreshPricingFromModelsDev } from "../be/pricing-refresh";

const TEST_DB_PATH = "./test-pricing-refresh.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function responseFor(cache: ModelsDevCache, etag = '"test-etag"'): Response {
  return new Response(JSON.stringify(cache), {
    status: 200,
    headers: { "content-type": "application/json", etag },
  });
}

function openAiCache(input: number, output: number): ModelsDevCache {
  return {
    openai: {
      models: {
        "gpt-refresh-test": {
          cost: { input, output },
        },
      },
    },
  };
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

afterEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM pricing").run();
  db.prepare("DELETE FROM agent_log WHERE eventType LIKE 'pricing.refresh%'").run();
});

describe("models.dev runtime pricing refresh", () => {
  test("inserts a new effective row when upstream price changes and no-ops identical prices", async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO pricing
       (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
       VALUES ('codex', 'gpt-refresh-test', 'input', 0, 1, 0, 0)`,
    ).run();

    const first = await refreshPricingFromModelsDev({
      now: 1_000,
      fetchImpl: async () => responseFor(openAiCache(2, 8), '"etag-1"'),
    });
    expect(first.status).toBe("refreshed");
    expect(first.candidateRows).toBe(6);
    expect(first.inserted).toBe(6);
    expect(first.unchanged).toBe(0);

    const activeChanged = getActivePricingRow("codex", "gpt-refresh-test", "input", 1_000);
    expect(activeChanged?.effectiveFrom).toBe(1_000);
    expect(activeChanged?.pricePerMillionUsd).toBe(2);
    const activeAiSdkAgentChanged = getActivePricingRow(
      "ai-sdk-agent",
      "gpt-refresh-test",
      "input",
      1_000,
    );
    expect(activeAiSdkAgentChanged?.effectiveFrom).toBe(1_000);
    expect(activeAiSdkAgentChanged?.pricePerMillionUsd).toBe(2);

    const second = await refreshPricingFromModelsDev({
      now: 2_000,
      fetchImpl: async () => responseFor(openAiCache(2, 8), '"etag-2"'),
    });
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(6);

    const rows = db
      .prepare<{ effective_from: number }, []>(
        `SELECT effective_from FROM pricing
         WHERE provider = 'codex'
           AND model = 'gpt-refresh-test'
           AND token_class = 'input'
         ORDER BY effective_from`,
      )
      .all();
    expect(rows.map((row) => row.effective_from)).toEqual([0, 1_000]);
  });

  test("sends If-None-Match and short-circuits on HTTP 304", async () => {
    await refreshPricingFromModelsDev({
      now: 1_000,
      fetchImpl: async () => responseFor(openAiCache(2, 8), '"etag-304"'),
    });

    let ifNoneMatch: string | null = null;
    const result = await refreshPricingFromModelsDev({
      now: 2_000,
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers);
        ifNoneMatch = headers.get("if-none-match");
        return new Response(null, { status: 304 });
      },
    });

    expect(ifNoneMatch).toBe('"etag-304"');
    expect(result.status).toBe("not_modified");
    expect(result.inserted).toBe(0);
  });

  test("prunes pricing history to the latest two effective rows per triple", async () => {
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO pricing
       (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
       VALUES ('codex', 'gpt-refresh-test', 'input', ?, ?, 0, 0)`,
    );
    insert.run(1_000, 1);
    insert.run(2_000, 2);
    insert.run(3_000, 3);

    const result = await refreshPricingFromModelsDev({
      now: 4_000,
      fetchImpl: async () => responseFor(openAiCache(3, 8), '"etag-prune"'),
    });

    expect(result.pruned).toBe(1);
    const rows = db
      .prepare<{ effective_from: number }, []>(
        `SELECT effective_from FROM pricing
         WHERE provider = 'codex'
           AND model = 'gpt-refresh-test'
           AND token_class = 'input'
         ORDER BY effective_from`,
      )
      .all();
    expect(rows.map((row) => row.effective_from)).toEqual([2_000, 3_000]);
  });

  test("writes scrubbed audit log entries for successful refreshes", async () => {
    await refreshPricingFromModelsDev({
      now: 1_000,
      fetchImpl: async () => responseFor(openAiCache(2, 8), '"etag-log"'),
    });

    const logs = getLogsByEventType("pricing.refresh");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.newValue).toContain("inserted=6");
    expect(logs[0]?.metadata).toContain('"etag":"\\"etag-log\\""');
  });
});
