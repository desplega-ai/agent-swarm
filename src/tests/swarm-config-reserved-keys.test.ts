import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  deleteSwarmConfig,
  getDb,
  getSwarmConfigs,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { isReservedConfigKey, reservedKeyError } from "../be/swarm-config-guard";
import { handleConfig } from "../http/config";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerDeleteConfigTool } from "../tools/swarm-config/delete-config";
import { registerSetConfigTool } from "../tools/swarm-config/set-config";

const TEST_DB_PATH = "./test-swarm-config-reserved-keys.sqlite";
const TEST_PORT = 13047;

const EXPECTED_MESSAGE = (key: string) =>
  `Key '${key}' is reserved and cannot be stored in swarm_config. ` +
  `Set it as an environment variable instead.`;

// Insert a legacy reserved-key row directly, bypassing the guard, to simulate
// data that predates the hardening (so we can verify delete is still blocked).
function insertLegacyReservedRow(key: string, value = "legacy"): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, envPath, description, createdAt, lastUpdatedAt)
     VALUES (?, ?, NULL, ?, ?, 0, NULL, NULL, ?, ?)`,
    [id, "global", key, value, now, now],
  );
  return id;
}

function deleteRawRow(id: string) {
  getDb().run("DELETE FROM swarm_config WHERE id = ?", [id]);
}

// ─── Minimal MCP server mock ────────────────────────────────────────────────
type ToolHandler = (args: unknown, meta: unknown) => Promise<unknown> | unknown;

class MockMcpServer {
  handlers = new Map<string, ToolHandler>();

  registerTool(name: string, _config: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
    return { name };
  }
}

function makeRequestInfo(agentId = "11111111-1111-1111-1111-111111111111") {
  // `getRequestInfo` reads `req.requestInfo?.headers?.["x-agent-id"]`
  return {
    sessionId: "test-session",
    requestInfo: {
      headers: {
        "x-agent-id": agentId,
      },
    },
  };
}

// ─── Minimal HTTP test server ───────────────────────────────────────────────
function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const handled = await handleConfig(req, res, pathSegments, queryParams);
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

describe("swarm-config reserved keys guard", () => {
  let server: Server;
  const baseUrl = `http://localhost:${TEST_PORT}`;
  const mcpServer = new MockMcpServer();

  beforeAll(async () => {
    initDb(TEST_DB_PATH);

    // Register MCP tools against the mock server so we can invoke their handlers directly.
    registerSetConfigTool(mcpServer as unknown as Parameters<typeof registerSetConfigTool>[0]);
    registerDeleteConfigTool(
      mcpServer as unknown as Parameters<typeof registerDeleteConfigTool>[0],
    );

    server = createTestServer();
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
  });

  // ─── Helper predicate ─────────────────────────────────────────────────────
  describe("isReservedConfigKey helper", () => {
    test("recognizes API_KEY", () => {
      expect(isReservedConfigKey("API_KEY")).toBe(true);
    });

    test("recognizes SECRETS_ENCRYPTION_KEY", () => {
      expect(isReservedConfigKey("SECRETS_ENCRYPTION_KEY")).toBe(true);
    });

    test("case-insensitive match: api_key, Api_Key, secrets_encryption_key", () => {
      expect(isReservedConfigKey("api_key")).toBe(true);
      expect(isReservedConfigKey("Api_Key")).toBe(true);
      expect(isReservedConfigKey("secrets_encryption_key")).toBe(true);
      expect(isReservedConfigKey("Secrets_Encryption_Key")).toBe(true);
    });

    test("does not match unrelated keys", () => {
      expect(isReservedConfigKey("OPENAI_API_KEY")).toBe(false);
      expect(isReservedConfigKey("API_KEYS")).toBe(false);
      expect(isReservedConfigKey("telemetry_user_id")).toBe(false);
    });

    test("reservedKeyError carries the exact message", () => {
      expect(reservedKeyError("API_KEY").message).toBe(EXPECTED_MESSAGE("API_KEY"));
    });
  });

  // ─── DB helper: upsertSwarmConfig ─────────────────────────────────────────
  describe("upsertSwarmConfig", () => {
    test("rejects API_KEY", () => {
      expect(() => upsertSwarmConfig({ scope: "global", key: "API_KEY", value: "secret" })).toThrow(
        EXPECTED_MESSAGE("API_KEY"),
      );
    });

    test("rejects SECRETS_ENCRYPTION_KEY", () => {
      expect(() =>
        upsertSwarmConfig({
          scope: "global",
          key: "SECRETS_ENCRYPTION_KEY",
          value: "abc",
        }),
      ).toThrow(EXPECTED_MESSAGE("SECRETS_ENCRYPTION_KEY"));
    });

    test("rejects case variants: api_key, Api_Key, secrets_encryption_key", () => {
      expect(() => upsertSwarmConfig({ scope: "global", key: "api_key", value: "x" })).toThrow(
        EXPECTED_MESSAGE("api_key"),
      );
      expect(() => upsertSwarmConfig({ scope: "global", key: "Api_Key", value: "x" })).toThrow(
        EXPECTED_MESSAGE("Api_Key"),
      );
      expect(() =>
        upsertSwarmConfig({
          scope: "global",
          key: "secrets_encryption_key",
          value: "x",
        }),
      ).toThrow(EXPECTED_MESSAGE("secrets_encryption_key"));
    });

    test("accepts non-reserved keys (OPENAI_API_KEY, telemetry_user_id)", () => {
      const openai = upsertSwarmConfig({
        scope: "global",
        key: "OPENAI_API_KEY",
        value: "sk-test",
        isSecret: true,
      });
      expect(openai.key).toBe("OPENAI_API_KEY");

      const telem = upsertSwarmConfig({
        scope: "global",
        key: "telemetry_user_id",
        value: "user-123",
      });
      expect(telem.key).toBe("telemetry_user_id");
    });
  });

  // ─── DB helper: deleteSwarmConfig ─────────────────────────────────────────
  describe("deleteSwarmConfig", () => {
    test("refuses to delete a reserved-key row even if one exists in the DB", () => {
      const id = insertLegacyReservedRow("API_KEY", "legacy-value");

      expect(() => deleteSwarmConfig(id)).toThrow(EXPECTED_MESSAGE("API_KEY"));

      // Clean up so subsequent tests aren't polluted.
      deleteRawRow(id);
    });

    test("still deletes non-reserved rows", () => {
      const inserted = upsertSwarmConfig({
        scope: "global",
        key: "TEMP_DELETE_ME",
        value: "x",
      });
      expect(deleteSwarmConfig(inserted.id)).toBe(true);
      const remaining = getSwarmConfigs({ scope: "global", key: "TEMP_DELETE_ME" });
      expect(remaining).toHaveLength(0);
    });
  });

  // ─── MCP tool: set-config ─────────────────────────────────────────────────
  describe("MCP set-config tool", () => {
    test("rejects reserved key with structured error", async () => {
      const handler = mcpServer.handlers.get("set-config");
      expect(handler).toBeDefined();

      const result = (await handler!(
        { scope: "global", key: "API_KEY", value: "secret" },
        makeRequestInfo(),
      )) as { structuredContent: { success: boolean; message: string } };

      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.message).toBe(EXPECTED_MESSAGE("API_KEY"));
    });

    test("rejects case variant 'api_key'", async () => {
      const handler = mcpServer.handlers.get("set-config");
      const result = (await handler!(
        { scope: "global", key: "api_key", value: "secret" },
        makeRequestInfo(),
      )) as { structuredContent: { success: boolean; message: string } };

      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.message).toBe(EXPECTED_MESSAGE("api_key"));
    });

    test("accepts non-reserved OPENAI_API_KEY", async () => {
      const handler = mcpServer.handlers.get("set-config");
      const result = (await handler!(
        { scope: "global", key: "OPENAI_API_KEY_FROM_MCP", value: "sk-mcp" },
        makeRequestInfo(),
      )) as { structuredContent: { success: boolean } };

      expect(result.structuredContent.success).toBe(true);
    });
  });

  // ─── MCP tool: delete-config ──────────────────────────────────────────────
  describe("MCP delete-config tool", () => {
    test("refuses to delete a reserved-key row with structured error", async () => {
      const id = insertLegacyReservedRow("SECRETS_ENCRYPTION_KEY");

      const handler = mcpServer.handlers.get("delete-config");
      const result = (await handler!({ id }, makeRequestInfo())) as {
        structuredContent: { success: boolean; message: string };
      };

      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.message).toBe(EXPECTED_MESSAGE("SECRETS_ENCRYPTION_KEY"));

      deleteRawRow(id);
    });

    test("still deletes non-reserved rows", async () => {
      const inserted = upsertSwarmConfig({
        scope: "global",
        key: "TEMP_MCP_DELETE",
        value: "x",
      });
      const handler = mcpServer.handlers.get("delete-config");
      const result = (await handler!({ id: inserted.id }, makeRequestInfo())) as {
        structuredContent: { success: boolean };
      };
      expect(result.structuredContent.success).toBe(true);
    });
  });

  // ─── HTTP: PUT /api/config ────────────────────────────────────────────────
  describe("HTTP PUT /api/config", () => {
    test("returns 400 for reserved key API_KEY", async () => {
      const res = await fetch(`${baseUrl}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "global",
          key: "API_KEY",
          value: "nope",
          isSecret: true,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(EXPECTED_MESSAGE("API_KEY"));
    });

    test("returns 400 for case variant 'Api_Key'", async () => {
      const res = await fetch(`${baseUrl}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "global",
          key: "Api_Key",
          value: "nope",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(EXPECTED_MESSAGE("Api_Key"));
    });

    test("returns 400 for SECRETS_ENCRYPTION_KEY", async () => {
      const res = await fetch(`${baseUrl}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "global",
          key: "SECRETS_ENCRYPTION_KEY",
          value: "nope",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("accepts non-reserved OPENAI_API_KEY", async () => {
      const res = await fetch(`${baseUrl}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "global",
          key: "OPENAI_API_KEY_HTTP",
          value: "sk-http",
          isSecret: true,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { key: string };
      expect(body.key).toBe("OPENAI_API_KEY_HTTP");
    });
  });

  // ─── HTTP: DELETE /api/config/{id} ────────────────────────────────────────
  describe("HTTP DELETE /api/config/{id}", () => {
    test("returns 400 when trying to delete a reserved-key row", async () => {
      const id = insertLegacyReservedRow("API_KEY");

      const res = await fetch(`${baseUrl}/api/config/${id}`, { method: "DELETE" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(EXPECTED_MESSAGE("API_KEY"));

      deleteRawRow(id);
    });

    test("still deletes non-reserved rows via HTTP", async () => {
      const inserted = upsertSwarmConfig({
        scope: "global",
        key: "HTTP_TEMP_DELETE",
        value: "x",
      });
      const res = await fetch(`${baseUrl}/api/config/${inserted.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });
  });
});
