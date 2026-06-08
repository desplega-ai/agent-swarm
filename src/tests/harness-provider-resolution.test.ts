/**
 * Coverage for the swarm_config-overrides-HARNESS_PROVIDER work:
 *
 *   - `resolveHarnessProvider` precedence (resolvedEnv > fallbackEnv > "claude")
 *     and invalid-value fallback.
 *   - `validateConfigValue` rejects unknown providers (used by HTTP +
 *     MCP write paths).
 *   - `getResolvedConfig` honours scope precedence (repo > agent > global)
 *     for HARNESS_PROVIDER, mirroring how MODEL_OVERRIDE already works.
 *   - End-to-end through `PUT /api/config`: a typo'd HARNESS_PROVIDER is
 *     rejected with 400 instead of being silently stored.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  getDb,
  getResolvedConfig,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { validateConfigValue } from "../be/swarm-config-guard";
import { handleConfig } from "../http/config";
import { resolveHarnessProvider } from "../utils/harness-provider";

const TEST_DB_PATH = "./test-harness-provider-resolution.sqlite";
const TEST_PORT = 13061;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function makeTestServer(): Server {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${TEST_PORT}`);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const queryParams = url.searchParams;
    try {
      if (await handleConfig(req, res, pathSegments, queryParams)) return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

let server: Server;
const baseUrl = `http://localhost:${TEST_PORT}`;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = makeTestServer();
  await new Promise<void>((resolve) => {
    server.listen(TEST_PORT, () => resolve());
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  getDb().prepare("DELETE FROM swarm_config").run();
  getDb().prepare("DELETE FROM agents").run();
});

// ─── resolveHarnessProvider ──────────────────────────────────────────────────

describe("resolveHarnessProvider", () => {
  test("returns 'claude' when neither env has HARNESS_PROVIDER", () => {
    expect(resolveHarnessProvider({}, {})).toBe("claude");
  });

  test("returns the value from resolvedEnv (swarm_config overlay) when present", () => {
    expect(
      resolveHarnessProvider({ HARNESS_PROVIDER: "codex" }, { HARNESS_PROVIDER: "claude" }),
    ).toBe("codex");
  });

  test("falls back to fallbackEnv when resolvedEnv lacks the key", () => {
    expect(resolveHarnessProvider({}, { HARNESS_PROVIDER: "pi" })).toBe("pi");
  });

  test("ignores empty string in resolvedEnv and falls back", () => {
    expect(resolveHarnessProvider({ HARNESS_PROVIDER: "  " }, { HARNESS_PROVIDER: "codex" })).toBe(
      "codex",
    );
  });

  test("invalid value falls back to 'claude' (does not throw)", () => {
    expect(resolveHarnessProvider({ HARNESS_PROVIDER: "not-a-provider" }, {})).toBe("claude");
  });

  test("trims whitespace before validating", () => {
    expect(resolveHarnessProvider({ HARNESS_PROVIDER: "  codex  " }, {})).toBe("codex");
  });
});

// ─── validateConfigValue ─────────────────────────────────────────────────────

describe("validateConfigValue", () => {
  test("returns null for keys without a validator", () => {
    expect(validateConfigValue("FOO_BAR", "anything")).toBeNull();
    expect(validateConfigValue("MODEL_OVERRIDE", "sonnet")).toBeNull();
  });

  test("accepts a valid HARNESS_PROVIDER", () => {
    expect(validateConfigValue("HARNESS_PROVIDER", "codex")).toBeNull();
    expect(validateConfigValue("harness_provider", "claude")).toBeNull(); // case-insensitive
  });

  test("rejects an unknown HARNESS_PROVIDER with a helpful error", () => {
    const err = validateConfigValue("HARNESS_PROVIDER", "claude-cod");
    expect(err).not.toBeNull();
    expect(err).toMatch(/HARNESS_PROVIDER/);
    expect(err).toMatch(/claude/);
    expect(err).toMatch(/codex/);
  });

  test("rejects non-string values for HARNESS_PROVIDER", () => {
    expect(validateConfigValue("HARNESS_PROVIDER", 42)).not.toBeNull();
    expect(validateConfigValue("HARNESS_PROVIDER", null)).not.toBeNull();
  });

  test("accepts a valid CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS", () => {
    expect(validateConfigValue("CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS", "7200000")).toBeNull();
    expect(validateConfigValue("CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS", "1800000")).toBeNull();
    // case-insensitive key lookup
    expect(validateConfigValue("codex_credits_exhausted_cooldown_ms", "60000")).toBeNull();
  });

  test("rejects non-positive / non-numeric CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS", () => {
    for (const bad of ["abc", "0", "-5", ""]) {
      const err = validateConfigValue("CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS", bad);
      expect(err).not.toBeNull();
      expect(err).toMatch(/CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS/);
    }
  });

  test("rejects partial-numeric CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS values", () => {
    for (const bad of ["60000ms", "1.5", "123abc", "1e5", " 60000 ms"]) {
      const err = validateConfigValue("CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS", bad);
      expect(err).not.toBeNull();
      expect(err).toMatch(/CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS/);
    }
  });

  test("accepts only boolean-like SWARM_USE_CLAUDE_BRIDGE values", () => {
    for (const value of ["true", "false", "1", "0", " TRUE "]) {
      expect(validateConfigValue("SWARM_USE_CLAUDE_BRIDGE", value)).toBeNull();
    }
    expect(validateConfigValue("SWARM_USE_CLAUDE_BRIDGE", "yes")).toMatch(
      /SWARM_USE_CLAUDE_BRIDGE/,
    );
    expect(validateConfigValue("SWARM_USE_CLAUDE_BRIDGE", true)).toMatch(/SWARM_USE_CLAUDE_BRIDGE/);
  });
});

// ─── getResolvedConfig — scope precedence for HARNESS_PROVIDER ───────────────

describe("getResolvedConfig precedence for HARNESS_PROVIDER", () => {
  test("agent scope wins over global scope", () => {
    const a = createAgent({
      name: "scope-test-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    upsertSwarmConfig({ scope: "global", key: "HARNESS_PROVIDER", value: "claude" });
    upsertSwarmConfig({
      scope: "agent",
      scopeId: a.id,
      key: "HARNESS_PROVIDER",
      value: "codex",
    });

    const resolved = getResolvedConfig(a.id);
    const harness = resolved.find((c) => c.key === "HARNESS_PROVIDER");
    expect(harness?.value).toBe("codex");
  });

  test("global scope applies when no agent-scoped row exists", () => {
    const a = createAgent({
      name: "scope-test-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    upsertSwarmConfig({ scope: "global", key: "HARNESS_PROVIDER", value: "pi" });

    const resolved = getResolvedConfig(a.id);
    const harness = resolved.find((c) => c.key === "HARNESS_PROVIDER");
    expect(harness?.value).toBe("pi");
  });

  test("nothing resolved when no rows exist (env fallback handled by runner)", () => {
    const resolved = getResolvedConfig("agent-nonexistent");
    expect(resolved.find((c) => c.key === "HARNESS_PROVIDER")).toBeUndefined();
  });
});

// ─── PUT /api/config — guard rejects invalid HARNESS_PROVIDER ────────────────

describe("PUT /api/config rejects invalid HARNESS_PROVIDER", () => {
  test("400 when value is not in ProviderNameSchema", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        key: "HARNESS_PROVIDER",
        value: "not-a-real-provider",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/HARNESS_PROVIDER/);
  });

  test("200 for a valid value, persists row", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        key: "HARNESS_PROVIDER",
        value: "codex",
      }),
    });
    expect(res.status).toBe(200);

    const rows = getResolvedConfig();
    const harness = rows.find((c) => c.key === "HARNESS_PROVIDER");
    expect(harness?.value).toBe("codex");
  });

  test("400 still rejects via PUT when scope=agent", async () => {
    const a = createAgent({
      name: "scope-test-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const res = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        scopeId: a.id,
        key: "HARNESS_PROVIDER",
        value: "claude-codex",
      }),
    });
    expect(res.status).toBe(400);
  });
});
