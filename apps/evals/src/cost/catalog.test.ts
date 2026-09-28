import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDb, initDb, resetDbForTests } from "../db/client.ts";
import {
  getCatalog,
  loadCatalogFromDb,
  MAX_CATALOG_BYTES,
  type ModelsDevCatalog,
  refreshCatalog,
  resetCatalogForTests,
  sanitizeCatalog,
} from "./catalog.ts";
import { getClaudeAliasMap, listOpenrouterModels, lookupModelCost } from "./pricing.ts";

const FIXTURE: ModelsDevCatalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-9-9": {
        name: "Claude Opus 9.9",
        release_date: "2099-01-01",
        cost: { input: 1, output: 2 },
      },
    },
  },
  openai: { id: "openai", name: "OpenAI", models: { "gpt-9": { name: "GPT-9" } } },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    models: { "acme/fixture-1": { name: "Fixture 1", cost: { input: 3, output: 4 } } },
  },
};

function fakeFetch(responses: Array<() => Response>, seen: Headers[] = []): typeof fetch {
  let i = 0;
  return (async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    const next = responses[Math.min(i++, responses.length - 1)];
    if (!next) throw new Error("no response");
    return next();
  }) as typeof fetch;
}

const ok = () => new Response(JSON.stringify(FIXTURE), { status: 200, headers: { etag: '"v1"' } });

// Never let this suite reach a real Turso DB from the ambient env.
const ENV_KEYS = ["EVALS_DB_SYNC_URL", "EVALS_DB_AUTH_TOKEN", "EVALS_DB_PATH"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(async () => {
  resetCatalogForTests();
  resetDbForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
  await initDb();
});

afterEach(() => {
  resetCatalogForTests();
  resetDbForTests();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("model catalog", () => {
  test("empty cache serves the committed snapshot", async () => {
    const state = await getCatalog();
    expect(state.source).toBe("snapshot");
    expect(Object.keys(state.catalog.openrouter?.models ?? {}).length).toBeGreaterThan(0);
  });

  test("a live fetch replaces the catalog and feeds pricing and aliases", async () => {
    const db = getDb();
    const r = await refreshCatalog({ db, fetchImpl: fakeFetch([ok]) });
    expect(r.status).toBe("updated");
    expect((await getCatalog()).source).toBe("live");
    expect((await listOpenrouterModels()).map((m) => m.id)).toEqual(["acme/fixture-1"]);
    expect((await getClaudeAliasMap()).opus).toBe("claude-opus-9-9");
    expect((await lookupModelCost("claude", "opus"))?.inputPerM).toBe(1);
  });

  test("fetch failure keeps the previous catalog", async () => {
    const db = getDb();
    await refreshCatalog({ db, fetchImpl: fakeFetch([ok]) });
    const boom = await refreshCatalog({
      db,
      fetchImpl: fakeFetch([
        () => {
          throw new Error("network down");
        },
      ]),
    });
    expect(boom).toEqual({ status: "error", error: "network down" });
    expect((await getCatalog()).source).toBe("live");
    expect((await listOpenrouterModels()).map((m) => m.id)).toEqual(["acme/fixture-1"]);
  });

  test("fetch failure on a cold cache falls back to the snapshot", async () => {
    const r = await refreshCatalog({
      db: getDb(),
      fetchImpl: fakeFetch([() => new Response("oops", { status: 500 })]),
    });
    expect(r.status).toBe("error");
    expect((await getCatalog()).source).toBe("snapshot");
  });

  test("an invalid payload is rejected", async () => {
    const r = await refreshCatalog({
      db: getDb(),
      fetchImpl: fakeFetch([() => new Response(JSON.stringify({ openrouter: {} }))]),
    });
    expect(r.status).toBe("error");
    expect((await getCatalog()).source).toBe("snapshot");
  });

  test("an oversized payload is rejected before parsing", async () => {
    const r = await refreshCatalog({
      db: getDb(),
      fetchImpl: fakeFetch([
        () =>
          new Response("{}", {
            headers: { "content-length": String(MAX_CATALOG_BYTES + 1) },
          }),
      ]),
    });
    expect(r.status).toBe("error");
    expect((await getCatalog()).source).toBe("snapshot");
  });

  test("sanitizing drops unknown fields and malformed entries", () => {
    const section = (models: unknown) => ({ id: "x", name: "X", extra: "drop", models });
    const good = { name: "M", cost: { input: 1, output: -5, evil: 9 }, junk: { a: 1 } };
    const out = sanitizeCatalog({
      anthropic: section({ a: good, bad: "not-an-object" }),
      openai: section({ o: good }),
      openrouter: section({ r: good }),
      rogue: section({ z: good }),
    });
    expect(Object.keys(out ?? {}).sort()).toEqual(["anthropic", "openai", "openrouter"]);
    expect(out?.anthropic?.models).toEqual({ a: { name: "M", cost: { input: 1 } } });
  });

  test("revalidates with the stored ETag and handles 304", async () => {
    const db = getDb();
    const seen: Headers[] = [];
    const fetchImpl = fakeFetch([ok, () => new Response(null, { status: 304 })], seen);
    await refreshCatalog({ db, fetchImpl, now: () => new Date("2026-01-01T00:00:00Z") });
    const r = await refreshCatalog({ db, fetchImpl, now: () => new Date("2026-01-02T00:00:00Z") });
    expect(seen[0]?.get("if-none-match")).toBeNull();
    expect(seen[1]?.get("if-none-match")).toBe('"v1"');
    expect(r).toEqual({ status: "not-modified", fetchedAt: "2026-01-02T00:00:00.000Z" });
    expect((await getCatalog()).fetchedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  test("a restart loads the last good payload from the DB", async () => {
    const db = getDb();
    await refreshCatalog({ db, fetchImpl: fakeFetch([ok]) });
    resetCatalogForTests();
    expect((await getCatalog()).source).toBe("snapshot");
    expect(await loadCatalogFromDb(db)).toBe(true);
    const state = await getCatalog();
    expect(state.source).toBe("db");
    expect(state.etag).toBe('"v1"');
    expect((await listOpenrouterModels()).map((m) => m.id)).toEqual(["acme/fixture-1"]);
  });
});
