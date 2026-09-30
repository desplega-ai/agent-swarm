import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configs as seedConfigs } from "../../configs/index.ts";
import { DEFAULT_SCENARIO_IDS } from "../../scenarios/index.ts";
import { getResolutionCatalog } from "../cost/catalog.ts";
import { resolveAlias } from "../cost/resolve-alias.ts";
import { getDb, initDb, resetDbForTests } from "../db/client.ts";
import { getHarnessConfig, syncSeedConfigs } from "../db/harness-configs.ts";
import { loadRegistry, setDbConfigs } from "../registry.ts";
import { deriveConfigId } from "./configs-routes.ts";
import { startServer } from "./server.ts";

const ENV_KEYS = ["EVALS_API_KEY", "EVALS_DB_PATH", "EVALS_DB_SYNC_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

beforeEach(() => {
  resetDbForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
});

afterEach(() => {
  resetDbForTests();
  setDbConfigs(null);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function url(server: { port?: number }, path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

async function send(
  server: { port?: number },
  method: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(url(server, path), { method, headers, body: JSON.stringify(body) });
}

describe("harness_configs seeding", () => {
  test("seeds follow code until edited, then the DB row wins", async () => {
    const db = await initDb();
    const seed = {
      id: "pi-seed-test",
      provider: "pi" as const,
      label: "v1",
      model: "openrouter/a",
    };
    await syncSeedConfigs(db, [seed]);
    await syncSeedConfigs(db, [{ ...seed, label: "v2" }]);
    expect((await getHarnessConfig(db, seed.id))?.config.label).toBe("v2");

    await db.execute(
      "UPDATE harness_configs SET label = 'edited', source = 'user' WHERE id = 'pi-seed-test'",
    );
    await syncSeedConfigs(db, [{ ...seed, label: "v3" }]);
    const row = await getHarnessConfig(db, seed.id);
    expect(row?.config.label).toBe("edited");
    expect(row?.source).toBe("user");
  });

  test("deriveConfigId drops vendor paths and the claude- prefix", () => {
    expect(deriveConfigId("claude", "latest:anthropic/opus")).toBe("claude-opus");
    expect(deriveConfigId("pi", "openrouter/deepseek/deepseek-v4-flash")).toBe(
      "pi-deepseek-v4-flash",
    );
    expect(deriveConfigId("claude", "claude-opus-5-5")).toBe("claude-opus-5-5");
  });
});

describe("/api/configs", () => {
  test("GET lists every code seed from the table", async () => {
    const server = await startServer(0);
    try {
      const res = await fetch(url(server, "/api/configs"));
      const body = (await res.json()) as Array<{ id: string; source: string }>;
      expect(body.map((c) => c.id).sort()).toEqual(seedConfigs.map((c) => c.id).sort());
      expect(body.every((c) => c.source === "seed")).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("GET carries resolvedModel: the alias target today, null for pinned configs", async () => {
    const server = await startServer(0);
    try {
      const res = await fetch(url(server, "/api/configs"));
      const body = (await res.json()) as Array<{
        id: string;
        model: string | null;
        modelAlias: string | null;
        resolvedModel: string | null;
      }>;
      const catalog = await getResolutionCatalog();
      const aliased = body.filter((c) => c.modelAlias);
      expect(aliased.map((c) => c.id)).toEqual(
        expect.arrayContaining(["claude-haiku", "claude-sonnet", "claude-opus"]),
      );
      for (const c of aliased) {
        expect(c.resolvedModel).toBe(resolveAlias(c.modelAlias as string, catalog));
        expect(c.resolvedModel).not.toBeNull();
      }
      const opus = body.find((c) => c.id === "claude-opus");
      expect(opus?.resolvedModel).toStartWith("claude-opus");
      const piAlias = body.find((c) => c.modelAlias?.startsWith("latest:openrouter/"));
      expect(piAlias?.resolvedModel).toStartWith("openrouter/");
      const pinned = body.filter((c) => c.model !== null);
      expect(pinned.length).toBeGreaterThan(0);
      expect(pinned.every((c) => c.resolvedModel === null)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("POST and PATCH echo resolvedModel for alias configs", async () => {
    const server = await startServer(0);
    try {
      const created = await send(server, "POST", "/api/configs", {
        provider: "claude",
        modelAlias: "latest:anthropic/fable",
        id: "claude-fable-latest",
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as { resolvedModel: string | null };
      expect(createdBody.resolvedModel).toBe(
        resolveAlias("latest:anthropic/fable", await getResolutionCatalog()),
      );
      expect(createdBody.resolvedModel).toStartWith("claude-fable");

      const patched = await send(server, "PATCH", "/api/configs/claude-fable-latest", {
        label: "Fable (latest)",
      });
      expect(patched.status).toBe(200);
      const patchedBody = (await patched.json()) as { resolvedModel: string | null };
      expect(patchedBody.resolvedModel).toBe(createdBody.resolvedModel);

      const pinned = await send(server, "PATCH", "/api/configs/claude-fable-latest", {
        model: "claude-fable-5",
      });
      expect(((await pinned.json()) as { resolvedModel: string | null }).resolvedModel).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("POST and PATCH use the EVALS_API_KEY bearer guard", async () => {
    process.env.EVALS_API_KEY = "example-test-master-key";
    const server = await startServer(0);
    try {
      const body = {
        provider: "pi",
        model: "openrouter/deepseek/deepseek-v4-flash",
        id: "pi-auth",
      };
      expect((await send(server, "POST", "/api/configs", body)).status).toBe(401);
      expect((await send(server, "PATCH", "/api/configs/claude-opus", { label: "x" })).status).toBe(
        401,
      );
      expect(
        (await send(server, "POST", "/api/configs", body, "example-test-master-key")).status,
      ).toBe(201);
    } finally {
      server.stop(true);
    }
  });

  test("POST validates against the catalog and registers the config for runs", async () => {
    const server = await startServer(0);
    try {
      const bad = await send(server, "POST", "/api/configs", {
        provider: "pi",
        model: "openrouter/nope/not-a-model",
      });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toContain(
        "not in the openrouter catalog",
      );

      const badAlias = await send(server, "POST", "/api/configs", {
        provider: "claude",
        modelAlias: "latest:anthropic/nosuchfamily",
      });
      expect(badAlias.status).toBe(400);

      const both = await send(server, "POST", "/api/configs", {
        provider: "pi",
        model: "openrouter/deepseek/deepseek-v4-flash",
        modelAlias: "latest:openrouter/deepseek/deepseek-v4*",
      });
      expect(both.status).toBe(400);

      const ok = await send(server, "POST", "/api/configs", {
        provider: "pi",
        model: "openrouter/deepseek/deepseek-v4-flash",
        id: "pi-flash-user",
        label: "My flash",
      });
      expect(ok.status).toBe(201);
      expect(loadRegistry().configs.get("pi-flash-user")?.label).toBe("My flash");

      const dup = await send(server, "POST", "/api/configs", {
        provider: "pi",
        model: "openrouter/deepseek/deepseek-v4-flash",
        id: "pi-flash-user",
      });
      expect(dup.status).toBe(409);
    } finally {
      server.stop(true);
    }
  });

  test("PATCH edits mark the row user-owned and archive hides it", async () => {
    const server = await startServer(0);
    try {
      const res = await send(server, "PATCH", "/api/configs/claude-opus", {
        label: "Opus (edited)",
      });
      expect(res.status).toBe(200);
      const row = await getHarnessConfig(getDb(), "claude-opus");
      expect(row?.source).toBe("user");
      expect(row?.config.modelAlias).toBe("latest:anthropic/opus");

      const badModel = await send(server, "PATCH", "/api/configs/claude-opus", {
        model: "claude-nope",
      });
      expect(badModel.status).toBe(400);

      expect((await send(server, "PATCH", "/api/configs/missing-id", { label: "x" })).status).toBe(
        404,
      );

      await send(server, "PATCH", "/api/configs/claude-opus", { archived: true });
      expect(loadRegistry().configs.has("claude-opus")).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

describe("reasoning effort on configs", () => {
  const HAIKU = { provider: "claude", model: "claude-haiku-4-5" };

  test("GET carries effortLevels per config, from the catalog rule", async () => {
    const server = await startServer(0);
    try {
      const body = (await (await fetch(url(server, "/api/configs"))).json()) as Array<{
        id: string;
        reasoningEffort: string | null;
        effortLevels: string[];
      }>;
      expect(body.every((c) => c.reasoningEffort === null)).toBe(true);
      // an alias config's levels come from the model the alias resolves to
      const opus = body.find((c) => c.id === "claude-opus");
      expect(opus?.effortLevels.length).toBeGreaterThan(0);
      expect(opus?.effortLevels).not.toContain("max");
    } finally {
      server.stop(true);
    }
  });

  test("POST stores a supported effort and echoes it with the levels", async () => {
    const server = await startServer(0);
    try {
      const res = await send(server, "POST", "/api/configs", {
        ...HAIKU,
        id: "claude-haiku-low",
        reasoningEffort: "low",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { reasoningEffort: string; effortLevels: string[] };
      expect(body.reasoningEffort).toBe("low");
      expect(body.effortLevels).toContain("low");
      const row = await getHarnessConfig(getDb(), "claude-haiku-low");
      expect(row?.config.reasoningEffort).toBe("low");
      expect(loadRegistry().configs.get("claude-haiku-low")?.reasoningEffort).toBe("low");
    } finally {
      server.stop(true);
    }
  });

  test("POST refuses an effort the harness + model do not take, and a non-level", async () => {
    const server = await startServer(0);
    try {
      const unsupported = await send(server, "POST", "/api/configs", {
        ...HAIKU,
        id: "claude-haiku-max",
        reasoningEffort: "max",
      });
      expect(unsupported.status).toBe(400);
      expect(((await unsupported.json()) as { error: string }).error).toContain(
        'does not take effort "max"',
      );
      const junk = await send(server, "POST", "/api/configs", {
        ...HAIKU,
        id: "claude-haiku-junk",
        reasoningEffort: "ultra",
      });
      expect(junk.status).toBe(400);
      expect(await getHarnessConfig(getDb(), "claude-haiku-max")).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("PATCH sets, changes and clears the effort", async () => {
    const server = await startServer(0);
    try {
      await send(server, "POST", "/api/configs", { ...HAIKU, id: "claude-haiku-e" });
      const set = await send(server, "PATCH", "/api/configs/claude-haiku-e", {
        reasoningEffort: "high",
      });
      expect(set.status).toBe(200);
      expect(((await set.json()) as { reasoningEffort: string }).reasoningEffort).toBe("high");
      expect((await getHarnessConfig(getDb(), "claude-haiku-e"))?.config.reasoningEffort).toBe(
        "high",
      );

      const unsupported = await send(server, "PATCH", "/api/configs/claude-haiku-e", {
        reasoningEffort: "max",
      });
      expect(unsupported.status).toBe(400);

      const cleared = await send(server, "PATCH", "/api/configs/claude-haiku-e", {
        reasoningEffort: null,
      });
      expect(cleared.status).toBe(200);
      expect(
        (await getHarnessConfig(getDb(), "claude-haiku-e"))?.config.reasoningEffort,
      ).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("PATCH refuses a model swap that leaves the stored effort unsupported, unless the effort goes too", async () => {
    const server = await startServer(0);
    try {
      await send(server, "POST", "/api/configs", {
        provider: "codex",
        model: "gpt-5.6-sol",
        id: "codex-sol-max",
        reasoningEffort: "max",
      });
      const swap = await send(server, "PATCH", "/api/configs/codex-sol-max", {
        model: "gpt-5.5",
      });
      expect(swap.status).toBe(400);
      expect(((await swap.json()) as { error: string }).error).toContain('effort "max"');
      expect((await getHarnessConfig(getDb(), "codex-sol-max"))?.config.model).toBe("gpt-5.6-sol");

      const together = await send(server, "PATCH", "/api/configs/codex-sol-max", {
        model: "gpt-5.5",
        reasoningEffort: "high",
      });
      expect(together.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("effort is a code-seed field too: a seed default follows the code until edited", async () => {
    const db = await initDb();
    const seed = {
      id: "claude-seed-effort",
      provider: "claude" as const,
      model: "claude-haiku-4-5",
      reasoningEffort: "low" as const,
    };
    await syncSeedConfigs(db, [seed]);
    expect((await getHarnessConfig(db, seed.id))?.config.reasoningEffort).toBe("low");
    await syncSeedConfigs(db, [{ ...seed, reasoningEffort: "high" }]);
    expect((await getHarnessConfig(db, seed.id))?.config.reasoningEffort).toBe("high");
    await db.execute("UPDATE harness_configs SET source = 'user' WHERE id = 'claude-seed-effort'");
    await syncSeedConfigs(db, [{ ...seed, reasoningEffort: "medium" }]);
    expect((await getHarnessConfig(db, seed.id))?.config.reasoningEffort).toBe("high");
  });
});

describe("GET /api/effort-levels", () => {
  test("lists what a harness takes for a model, or for the model an alias resolves to", async () => {
    const server = await startServer(0);
    try {
      const pinned = (await (
        await fetch(url(server, "/api/effort-levels?provider=codex&model=gpt-5.6-sol"))
      ).json()) as { model: string; levels: string[] };
      expect(pinned.model).toBe("gpt-5.6-sol");
      expect(pinned.levels).toContain("max");

      const alias = (await (
        await fetch(
          url(
            server,
            `/api/effort-levels?provider=claude&modelAlias=${encodeURIComponent("latest:anthropic/opus")}`,
          ),
        )
      ).json()) as { model: string | null; levels: string[] };
      expect(alias.model).toStartWith("claude-opus");
      expect(alias.levels.length).toBeGreaterThan(0);

      const unresolved = (await (
        await fetch(
          url(
            server,
            `/api/effort-levels?provider=claude&modelAlias=${encodeURIComponent("latest:anthropic/nosuchfamily")}`,
          ),
        )
      ).json()) as { model: string | null; levels: string[] };
      expect(unresolved).toEqual({ model: null, levels: [] });
    } finally {
      server.stop(true);
    }
  });

  test("400 without a provider or a model, and the bearer guard applies", async () => {
    process.env.EVALS_API_KEY = "example-test-master-key";
    const server = await startServer(0);
    try {
      const auth = { headers: { authorization: "Bearer example-test-master-key" } };
      expect((await fetch(url(server, "/api/effort-levels?provider=claude&model=x"))).status).toBe(
        401,
      );
      expect((await fetch(url(server, "/api/effort-levels?model=x"), auth)).status).toBe(400);
      expect((await fetch(url(server, "/api/effort-levels?provider=claude"), auth)).status).toBe(
        400,
      );
      expect(
        (await fetch(url(server, "/api/effort-levels?provider=bogus&model=x"), auth)).status,
      ).toBe(400);
    } finally {
      server.stop(true);
    }
  });
});

describe("POST /api/runs efforts", () => {
  const runBody = { scenarioIds: [DEFAULT_SCENARIO_IDS[0]], configIds: ["claude-opus"] };

  test("an effort the config's pair does not take is a 400 before any run exists", async () => {
    const server = await startServer(0);
    try {
      const res = await send(server, "POST", "/api/runs", {
        ...runBody,
        efforts: { "claude-opus": "max" },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        'does not take effort "max"',
      );
      const runs = (await (await fetch(url(server, "/api/runs"))).json()) as unknown[];
      expect(runs).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("400 for a non-level, a malformed map, and a config outside the run", async () => {
    const server = await startServer(0);
    try {
      for (const efforts of [{ "claude-opus": "ultra" }, ["high"], { "codex-sol": "high" }]) {
        const res = await send(server, "POST", "/api/runs", { ...runBody, efforts });
        expect(res.status).toBe(400);
      }
    } finally {
      server.stop(true);
    }
  });
});
