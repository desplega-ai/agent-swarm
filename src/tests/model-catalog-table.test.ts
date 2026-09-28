import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getActivePricingRow, getDbClient, initDb } from "../be/db";
import {
  listModelCatalogOverlay,
  loadModelsCatalog,
  markModelsCatalogStale,
  upsertModelCatalogOverlay,
} from "../be/model-catalog-store";
import { getModelsCatalog, resetModelsCatalogForTests } from "../be/models-catalog";
import type { ModelsDevCache } from "../be/modelsdev-cache";
import { MODEL_CATALOG_FRESH_MS, refreshModelCatalog } from "../be/pricing-refresh";

const TEST_DB_PATH = "./test-model-catalog-table.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function payload(extraModels: Record<string, unknown> = {}): ModelsDevCache {
  return {
    openai: {
      name: "OpenAI",
      models: {
        "gpt-base": {
          name: "GPT Base",
          cost: { input: 1, output: 4 },
          limit: { context: 100_000 },
        },
        ...extraModels,
      },
    },
  } as ModelsDevCache;
}

function ok(cache: ModelsDevCache, etag: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(cache), {
      status: 200,
      headers: { "content-type": "application/json", etag },
    })) as unknown as typeof fetch;
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  // Module state may carry over from other files sharing this process.
  resetModelsCatalogForTests();
  markModelsCatalogStale();
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

afterEach(async () => {
  const client = getDbClient();
  await client.run("DELETE FROM model_catalog");
  await client.run("DELETE FROM model_catalog_overlay");
  await client.run("DELETE FROM model_catalog_meta");
  await client.run("DELETE FROM pricing WHERE model LIKE 'gpt-%'");
  resetModelsCatalogForTests();
  markModelsCatalogStale();
});

describe("persistent model catalog", () => {
  test("empty table serves the vendored snapshot", async () => {
    const result = await loadModelsCatalog();
    expect(result.source).toBe("snapshot");
    expect(result.updatedAt).toBeNull();
  });

  test("forced refresh adds a new model to the catalog and pricing without restart", async () => {
    await refreshModelCatalog({ force: true, now: 1_000, fetchImpl: ok(payload(), '"v1"') });

    const result = await refreshModelCatalog({
      force: true,
      now: 2_000,
      fetchImpl: ok(
        payload({ "gpt-brand-new": { name: "Brand New", cost: { input: 3, output: 9 } } }),
        '"v2"',
      ),
    });

    expect(result.status).toBe("updated");
    expect(result.added).toEqual(["openai/gpt-brand-new"]);
    expect(result.models).toBe(2);
    const catalog = await loadModelsCatalog();
    expect(catalog.source).toBe("live");
    expect(catalog.providers.openai?.models["gpt-brand-new"]?.cost?.input).toBe(3);
    const price = await getActivePricingRow("codex", "gpt-brand-new", "input", 2_000);
    expect(price?.pricePerMillionUsd).toBe(3);
  });

  test("304 keeps the catalog and bumps checkedAt", async () => {
    await refreshModelCatalog({ force: true, now: 1_000, fetchImpl: ok(payload(), '"v1"') });
    let sent: string | null = null;
    const result = await refreshModelCatalog({
      force: true,
      now: 5_000,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        sent = new Headers(init?.headers).get("if-none-match");
        return new Response(null, { status: 304 });
      }) as unknown as typeof fetch,
    });
    expect(sent).toBe('"v1"');
    expect(result.status).toBe("not-modified");
    expect(result.models).toBe(1);
    expect(result.checkedAt).toBe(5_000);
    const row = await getDbClient().get<{ checkedAt: number }>(
      "SELECT checkedAt FROM model_catalog WHERE modelId = 'gpt-base'",
    );
    expect(row?.checkedAt).toBe(5_000);
    expect(getModelsCatalog().providers.openai?.models["gpt-base"]).toBeDefined();
  });

  test("unforced refresh within 4h skips the network", async () => {
    await refreshModelCatalog({ now: 1_000, fetchImpl: ok(payload(), '"v1"') });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;
    const skipped = await refreshModelCatalog({ now: 1_000 + 60_000, fetchImpl });
    expect(skipped.status).toBe("skipped-fresh");
    expect(called).toBe(false);

    const stale = await refreshModelCatalog({ now: 1_000 + MODEL_CATALOG_FRESH_MS + 1, fetchImpl });
    expect(stale.status).toBe("not-modified");
    expect(called).toBe(true);
  });

  test("overlay-only model appears in the catalog and gets a pricing row", async () => {
    await refreshModelCatalog({ force: true, now: 1_000, fetchImpl: ok(payload(), '"v1"') });
    await upsertModelCatalogOverlay(
      {
        provider: "openai",
        modelId: "gpt-overlay-only",
        name: "Overlay Only",
        contextWindow: 400_000,
        pricing: { input: 7, output: 21 },
        reason: "launch blog",
      },
      { now: 2_000 },
    );
    const catalog = await loadModelsCatalog();
    const model = catalog.providers.openai?.models["gpt-overlay-only"];
    expect(model?.name).toBe("Overlay Only");
    expect(model?.limit?.context).toBe(400_000);
    const price = await getActivePricingRow("codex", "gpt-overlay-only", "output", 2_000);
    expect(price?.pricePerMillionUsd).toBe(21);
  });

  test("overlay wins per field over upstream", async () => {
    await refreshModelCatalog({ force: true, now: 1_000, fetchImpl: ok(payload(), '"v1"') });
    await upsertModelCatalogOverlay({
      provider: "openai",
      modelId: "gpt-base",
      contextWindow: 200_000,
      reason: "upstream wrong",
    });
    const model = (await loadModelsCatalog()).providers.openai?.models["gpt-base"];
    expect(model?.limit?.context).toBe(200_000);
    expect(model?.name).toBe("GPT Base");
  });

  test("overlay auto-expires once upstream matches", async () => {
    await refreshModelCatalog({ force: true, now: 1_000, fetchImpl: ok(payload(), '"v1"') });
    await upsertModelCatalogOverlay({
      provider: "openai",
      modelId: "gpt-late",
      name: "Late",
      pricing: { input: 2 },
      reason: "not on models.dev yet",
    });
    await upsertModelCatalogOverlay({
      provider: "openai",
      modelId: "gpt-pinned",
      name: "Pinned",
      reason: "keep",
      expiresWhenUpstreamMatches: false,
    });

    await refreshModelCatalog({
      force: true,
      now: 2_000,
      fetchImpl: ok(
        payload({
          "gpt-late": { name: "Late", cost: { input: 2, output: 8 } },
          "gpt-pinned": { name: "Pinned" },
        }),
        '"v2"',
      ),
    });

    const remaining = (await listModelCatalogOverlay()).map((o) => o.modelId);
    expect(remaining).toEqual(["gpt-pinned"]);
    const late = (await loadModelsCatalog()).providers.openai?.models["gpt-late"];
    expect(late?.cost?.output).toBe(8);
  });
});
