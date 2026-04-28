import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, deleteSwarmConfig, getSwarmConfigs, initDb, upsertSwarmConfig } from "../be/db";
import { type ClaudeManagedTestClient, createIntegrationsHandler } from "../http/integrations";
import { getPathSegments } from "../http/utils";

// ---------------------------------------------------------------------------
// Tests for POST /api/integrations/claude-managed/test
//
// Covers:
//   - Success path — beta.agents.retrieve returns name + model.
//   - Missing-config path — neither swarm_config nor process.env has the
//     required keys → ok:false with a hint to run the setup CLI.
//   - Anthropic API error path — retrieve throws → ok:false with the error
//     message; HTTP status remains 200 (per the route contract).
// ---------------------------------------------------------------------------

const TEST_DB_PATH = "./test-integrations-http.sqlite";
const TEST_PORT = 13089;

interface FakeClientLog {
  retrieveCalls: string[];
  retrieveResult?: { name?: string | null; model?: string | null };
  retrieveError?: Error;
}

function buildFakeClient(log: FakeClientLog): ClaudeManagedTestClient {
  return {
    beta: {
      agents: {
        retrieve: async (agentId: string) => {
          log.retrieveCalls.push(agentId);
          if (log.retrieveError) throw log.retrieveError;
          return log.retrieveResult ?? {};
        },
      },
    },
  };
}

function clearManagedConfigRows() {
  const all = getSwarmConfigs({ scope: "global" });
  for (const row of all) {
    if (
      row.key === "ANTHROPIC_API_KEY" ||
      row.key === "MANAGED_AGENT_ID" ||
      row.key === "MANAGED_ENVIRONMENT_ID"
    ) {
      deleteSwarmConfig(row.id);
    }
  }
  // Also scrub process.env so resolveConfigValue's fallback doesn't bleed
  // values from the host environment into the test.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MANAGED_AGENT_ID;
  delete process.env.MANAGED_ENVIRONMENT_ID;
}

describe("POST /api/integrations/claude-managed/test", () => {
  let server: Server;
  const baseUrl = `http://localhost:${TEST_PORT}`;
  const log: FakeClientLog = { retrieveCalls: [] };
  const savedEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    MANAGED_AGENT_ID: process.env.MANAGED_AGENT_ID,
    MANAGED_ENVIRONMENT_ID: process.env.MANAGED_ENVIRONMENT_ID,
  };

  beforeAll(async () => {
    initDb(TEST_DB_PATH);

    const handler = createIntegrationsHandler({
      buildClient: () => buildFakeClient(log),
    });

    server = createHttpServer(async (req, res) => {
      const pathSegments = getPathSegments(req.url || "");
      const handled = await handler(req, res, pathSegments);
      if (!handled) {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });
  });

  afterAll(async () => {
    server.close();
    closeDb();
    await unlink(TEST_DB_PATH).catch(() => {});
    await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
    await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
    // Restore original env so other test files aren't affected.
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    log.retrieveCalls = [];
    log.retrieveResult = undefined;
    log.retrieveError = undefined;
    clearManagedConfigRows();
  });

  test("success path — returns ok:true with agent name + model", async () => {
    upsertSwarmConfig({
      scope: "global",
      key: "ANTHROPIC_API_KEY",
      value: "sk-ant-test",
      isSecret: true,
    });
    upsertSwarmConfig({
      scope: "global",
      key: "MANAGED_AGENT_ID",
      value: "agent_abc123",
      isSecret: false,
    });

    log.retrieveResult = { name: "swarm-worker", model: "claude-sonnet-4-6" };

    const res = await fetch(`${baseUrl}/api/integrations/claude-managed/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      agentName: "swarm-worker",
      model: "claude-sonnet-4-6",
    });
    expect(log.retrieveCalls).toEqual(["agent_abc123"]);
  });

  test("missing-config path — returns ok:false with helpful error", async () => {
    // No swarm_config rows, no env. resolveConfigValue should return null
    // for both keys and short-circuit before calling Anthropic.
    const res = await fetch(`${baseUrl}/api/integrations/claude-managed/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("ANTHROPIC_API_KEY");
    expect(body.error).toContain("MANAGED_AGENT_ID");
    expect(body.error).toContain("claude-managed-setup");
    // No SDK call should have been attempted.
    expect(log.retrieveCalls).toHaveLength(0);
  });

  test("Anthropic API error — returns ok:false with the error message, HTTP 200", async () => {
    upsertSwarmConfig({
      scope: "global",
      key: "ANTHROPIC_API_KEY",
      value: "sk-ant-test",
      isSecret: true,
    });
    upsertSwarmConfig({
      scope: "global",
      key: "MANAGED_AGENT_ID",
      value: "agent_does_not_exist",
      isSecret: false,
    });

    log.retrieveError = new Error("404 not_found_error: agent not found");

    const res = await fetch(`${baseUrl}/api/integrations/claude-managed/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("agent not found");
    expect(log.retrieveCalls).toEqual(["agent_does_not_exist"]);
  });

  test("env-fallback path — uses process.env when swarm_config row missing", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fromenv";
    process.env.MANAGED_AGENT_ID = "agent_env_fallback";

    log.retrieveResult = { name: "from-env", model: "claude-sonnet-4-6" };

    const res = await fetch(`${baseUrl}/api/integrations/claude-managed/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      agentName: "from-env",
      model: "claude-sonnet-4-6",
    });
    expect(log.retrieveCalls).toEqual(["agent_env_fallback"]);
  });
});
