import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  deleteSwarmConfig,
  getDb,
  getSwarmConfigById,
  getSwarmConfigs,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { isReservedConfigKey, reservedKeyError } from "../be/swarm-config-guard";
import { handleConfig } from "../http/config";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerDeleteConfigTool } from "../tools/swarm-config/delete-config";
import { registerListConfigTool } from "../tools/swarm-config/list-config";
import { registerSetConfigTool } from "../tools/swarm-config/set-config";

const TEST_DB_PATH = "./test-swarm-config-reserved-keys.sqlite";
const TEST_PORT = 13047;

const EXPECTED_MESSAGE = (key: string) =>
  `Key '${key}' is reserved and cannot be stored in swarm_config. ` +
  `Set it as an environment variable instead.`;

// Insert a legacy reserved-key row directly, bypassing the guard, to simulate
// data that predates the hardening (so we can verify cleanup/remediation paths).
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

function insertUnreadableReservedSecretRow(key: string): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, envPath, description, createdAt, lastUpdatedAt, encrypted)
     VALUES (?, ?, NULL, ?, ?, 1, NULL, NULL, ?, ?, 1)`,
    [id, "global", key, "definitely-not-valid-ciphertext", now, now],
  );
  return id;
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
    registerListConfigTool(mcpServer as unknown as Parameters<typeof registerListConfigTool>[0]);

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
    test("allows deleting a legacy reserved-key row for cleanup", () => {
      const id = insertLegacyReservedRow("API_KEY", "legacy-value");

      expect(deleteSwarmConfig(id)).toBe(true);
      const remaining = getSwarmConfigs({ scope: "global", key: "API_KEY" });
      expect(remaining).toHaveLength(0);
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

  describe("reserved-row reads for cleanup", () => {
    test("getSwarmConfigById returns a cleanup placeholder instead of decrypting reserved rows", () => {
      const id = insertUnreadableReservedSecretRow("SECRETS_ENCRYPTION_KEY");

      const config = getSwarmConfigById(id);
      expect(config).not.toBeNull();
      expect(config?.key).toBe("SECRETS_ENCRYPTION_KEY");
      expect(config?.value).toContain("delete this row");
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
    test("allows deleting a legacy reserved-key row with structured success", async () => {
      const id = insertLegacyReservedRow("SECRETS_ENCRYPTION_KEY");

      const handler = mcpServer.handlers.get("delete-config");
      const result = (await handler!({ id }, makeRequestInfo())) as {
        structuredContent: { success: boolean; message: string };
      };

      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.message).toBe(
        'Config "SECRETS_ENCRYPTION_KEY" deleted successfully.',
      );
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

  describe("MCP list-config tool", () => {
    test("lists unreadable reserved rows without failing", async () => {
      const id = insertUnreadableReservedSecretRow("API_KEY");

      try {
        const handler = mcpServer.handlers.get("list-config");
        const result = (await handler!(
          { scope: "global", includeSecrets: true },
          makeRequestInfo(),
        )) as {
          structuredContent: {
            success: boolean;
            configs: Array<{ id: string; key: string; value: string }>;
          };
        };

        expect(result.structuredContent.success).toBe(true);
        expect(
          result.structuredContent.configs.some((c) => c.id === id && c.key === "API_KEY"),
        ).toBe(true);
      } finally {
        getDb().run("DELETE FROM swarm_config WHERE id = ?", [id]);
      }
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
    test("allows deleting a legacy reserved-key row for remediation", async () => {
      const id = insertLegacyReservedRow("API_KEY");

      const res = await fetch(`${baseUrl}/api/config/${id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });

    test("deletes an unreadable encrypted row without trying to decrypt it first", async () => {
      const inserted = upsertSwarmConfig({
        scope: "global",
        key: "UNREADABLE_DELETE_TARGET",
        value: "plaintext-before-corruption",
        isSecret: true,
      });

      const raw = getDb()
        .prepare<{ value: string }, [string]>("SELECT value FROM swarm_config WHERE id = ?")
        .get(inserted.id);
      expect(raw).not.toBeNull();
      const original = raw?.value ?? "";
      const corrupted =
        original.slice(0, 10) + (original[10] === "A" ? "B" : "A") + original.slice(11);
      getDb().run("UPDATE swarm_config SET value = ? WHERE id = ?", [corrupted, inserted.id]);

      const res = await fetch(`${baseUrl}/api/config/${inserted.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
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

  describe("HTTP GET config routes", () => {
    test("GET /api/config lists unreadable reserved rows instead of 500ing", async () => {
      const id = insertUnreadableReservedSecretRow("SECRETS_ENCRYPTION_KEY");

      try {
        const res = await fetch(`${baseUrl}/api/config?scope=global&includeSecrets=true`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          configs: Array<{ id: string; key: string; value: string }>;
        };
        expect(
          body.configs.some(
            (c) =>
              c.id === id &&
              c.key === "SECRETS_ENCRYPTION_KEY" &&
              c.value.includes("delete this row"),
          ),
        ).toBe(true);
      } finally {
        getDb().run("DELETE FROM swarm_config WHERE id = ?", [id]);
      }
    });
  });
});
