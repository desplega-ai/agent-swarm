import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configs as seedConfigs } from "../../configs/index.ts";
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
