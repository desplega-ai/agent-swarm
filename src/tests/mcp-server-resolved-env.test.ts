import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createMcpServer,
  getResolvedConfig,
  initDb,
  upsertSwarmConfig,
} from "../be/db";

const TEST_DB_PATH = "./test-mcp-server-resolved-env.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

/**
 * Replicates the resolvedEnv/resolvedHeaders logic from src/http/mcp-servers.ts
 * so we can unit-test it without spinning up the HTTP server.
 */
function resolveSecrets(
  server: { envConfigKeys: string | null; headerConfigKeys: string | null },
  configMap: Map<string, string>,
): { resolvedEnv: Record<string, string>; resolvedHeaders: Record<string, string> } {
  const resolvedEnv: Record<string, string> = {};
  const resolvedHeaders: Record<string, string> = {};

  if (server.envConfigKeys) {
    try {
      const parsed = JSON.parse(server.envConfigKeys);
      if (Array.isArray(parsed)) {
        for (const key of parsed) {
          const value = configMap.get(key);
          if (value !== undefined) {
            resolvedEnv[key] = value;
          }
        }
      } else {
        for (const [envVar, configKey] of Object.entries(parsed as Record<string, string>)) {
          const value = configMap.get(configKey);
          if (value !== undefined) {
            resolvedEnv[envVar] = value;
          }
        }
      }
    } catch {
      // Invalid JSON — skip resolution
    }
  }

  if (server.headerConfigKeys) {
    try {
      const parsed = JSON.parse(server.headerConfigKeys);
      if (Array.isArray(parsed)) {
        for (const key of parsed) {
          const value = configMap.get(key);
          if (value !== undefined) {
            resolvedHeaders[key] = value;
          }
        }
      } else {
        for (const [headerName, configKey] of Object.entries(parsed as Record<string, string>)) {
          const value = configMap.get(configKey);
          if (value !== undefined) {
            resolvedHeaders[headerName] = value;
          }
        }
      }
    } catch {
      // Invalid JSON — skip resolution
    }
  }

  return { resolvedEnv, resolvedHeaders };
}

describe("MCP server resolvedEnv key mapping", () => {
  const agentId = crypto.randomUUID();

  beforeAll(() => {
    createAgent({
      id: agentId,
      name: "test-agent",
      status: "idle",
      isLead: false,
    });

    // Store config values for the agent
    upsertSwarmConfig({
      scope: "agent",
      scopeId: agentId,
      key: "KEY_A",
      value: "value_a",
      isSecret: true,
    });
    upsertSwarmConfig({
      scope: "agent",
      scopeId: agentId,
      key: "KEY_B",
      value: "value_b",
      isSecret: true,
    });
    upsertSwarmConfig({
      scope: "agent",
      scopeId: agentId,
      key: "HEADER_X",
      value: "header_val",
      isSecret: true,
    });
  });

  test("array format envConfigKeys uses key names, not array indices", () => {
    const server = createMcpServer({
      name: "test-array-env",
      transport: "stdio",
      command: "node",
      scope: "agent",
      ownerAgentId: agentId,
      envConfigKeys: JSON.stringify(["KEY_A", "KEY_B"]),
    });

    const configs = getResolvedConfig(agentId);
    const configMap = new Map(configs.map((c) => [c.key, c.value]));

    const { resolvedEnv } = resolveSecrets(
      { envConfigKeys: server.envConfigKeys, headerConfigKeys: server.headerConfigKeys },
      configMap,
    );

    // Should use actual key names, NOT array indices "0" and "1"
    expect(resolvedEnv).toEqual({ KEY_A: "value_a", KEY_B: "value_b" });
    expect(resolvedEnv["0"]).toBeUndefined();
    expect(resolvedEnv["1"]).toBeUndefined();
  });

  test("object format envConfigKeys still works correctly", () => {
    const server = createMcpServer({
      name: "test-object-env",
      transport: "stdio",
      command: "node",
      scope: "agent",
      ownerAgentId: agentId,
      envConfigKeys: JSON.stringify({ MY_KEY_A: "KEY_A", MY_KEY_B: "KEY_B" }),
    });

    const configs = getResolvedConfig(agentId);
    const configMap = new Map(configs.map((c) => [c.key, c.value]));

    const { resolvedEnv } = resolveSecrets(
      { envConfigKeys: server.envConfigKeys, headerConfigKeys: server.headerConfigKeys },
      configMap,
    );

    expect(resolvedEnv).toEqual({ MY_KEY_A: "value_a", MY_KEY_B: "value_b" });
  });

  test("array format headerConfigKeys uses key names, not array indices", () => {
    const server = createMcpServer({
      name: "test-array-headers",
      transport: "http",
      url: "http://example.com",
      scope: "agent",
      ownerAgentId: agentId,
      headerConfigKeys: JSON.stringify(["HEADER_X"]),
    });

    const configs = getResolvedConfig(agentId);
    const configMap = new Map(configs.map((c) => [c.key, c.value]));

    const { resolvedHeaders } = resolveSecrets(
      { envConfigKeys: server.envConfigKeys, headerConfigKeys: server.headerConfigKeys },
      configMap,
    );

    expect(resolvedHeaders).toEqual({ HEADER_X: "header_val" });
    expect(resolvedHeaders["0"]).toBeUndefined();
  });

  test("missing config keys are skipped gracefully", () => {
    const configMap = new Map([["KEY_A", "value_a"]]);

    const { resolvedEnv } = resolveSecrets(
      { envConfigKeys: JSON.stringify(["KEY_A", "MISSING_KEY"]), headerConfigKeys: null },
      configMap,
    );

    expect(resolvedEnv).toEqual({ KEY_A: "value_a" });
  });

  test("invalid JSON envConfigKeys is skipped", () => {
    const configMap = new Map([["KEY_A", "value_a"]]);

    const { resolvedEnv } = resolveSecrets(
      { envConfigKeys: "not-valid-json{", headerConfigKeys: null },
      configMap,
    );

    expect(resolvedEnv).toEqual({});
  });

  test("null envConfigKeys produces empty resolvedEnv", () => {
    const configMap = new Map([["KEY_A", "value_a"]]);

    const { resolvedEnv } = resolveSecrets(
      { envConfigKeys: null, headerConfigKeys: null },
      configMap,
    );

    expect(resolvedEnv).toEqual({});
  });
});
