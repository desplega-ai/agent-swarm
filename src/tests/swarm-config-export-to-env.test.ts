import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, getSwarmConfigs, initDb, upsertSwarmConfig } from "../be/db";
import { handleConfig } from "../http/config";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerSetConfigTool } from "../tools/swarm-config/set-config";
import {
  ENV_EXPORT_RESTRICTED_KEYS,
  effectiveExportToEnv,
  envExportRestrictedError,
} from "../utils/config-env-export";
import { setRequestAuth } from "../utils/request-auth-context";
import { clearVolatileSecretsForTesting } from "../utils/secret-scrubber";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-swarm-config-export-to-env.sqlite";
const LEAD_ID = "21111111-1111-1111-1111-111111111111";
const MIGRATION = "src/be/migrations/215_swarm_config_export_to_env.sql";

type ToolHandler = (args: unknown, meta: unknown) => Promise<unknown> | unknown;

class MockMcpServer {
  handlers = new Map<string, ToolHandler>();
  registerTool(name: string, _config: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
    return { name };
  }
}

const requestInfo = {
  sessionId: "test-session",
  requestInfo: { headers: { "x-agent-id": LEAD_ID } },
};

describe("swarm_config exportToEnv", () => {
  let server: Server;
  let baseUrl = "";
  const mcpServer = new MockMcpServer();

  beforeAll(async () => {
    initDb(TEST_DB_PATH);
    await createAgent({
      id: LEAD_ID,
      name: "export-to-env-test-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    registerSetConfigTool(mcpServer as unknown as Parameters<typeof registerSetConfigTool>[0]);
    server = createHttpServer(async (req, res) => {
      setRequestAuth(req, { kind: "operator", fingerprint: "test" });
      const handled = await handleConfig(
        req,
        res,
        getPathSegments(req.url || ""),
        parseQueryParams(req.url || ""),
      );
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    baseUrl = `http://localhost:${await listenOnFreePort(server)}`;
  });

  afterAll(async () => {
    clearVolatileSecretsForTesting();
    server.close();
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
    }
  });

  test("new rows export by default; an update without the flag keeps it", async () => {
    const created = await upsertSwarmConfig({ scope: "global", key: "EXPORT_A", value: "1" });
    expect(created.exportToEnv).toBe(true);

    const off = await upsertSwarmConfig({
      scope: "global",
      key: "EXPORT_A",
      value: "2",
      isSecret: true,
      exportToEnv: false,
    });
    expect(off.exportToEnv).toBe(false);

    const kept = await upsertSwarmConfig({
      scope: "global",
      key: "EXPORT_A",
      value: "3",
      isSecret: true,
    });
    expect(kept.exportToEnv).toBe(false);

    const on = await upsertSwarmConfig({
      scope: "global",
      key: "EXPORT_A",
      value: "4",
      exportToEnv: true,
    });
    expect(on.exportToEnv).toBe(true);
  });

  test("default-off keys start off on create but accept an explicit true", async () => {
    const created = await upsertSwarmConfig({
      scope: "global",
      key: "KAPSO_WEBHOOK_HMAC_SECRET",
      value: "k",
      isSecret: true,
    });
    expect(created.exportToEnv).toBe(false);

    const optedIn = await upsertSwarmConfig({
      scope: "global",
      key: "X_CLIENT_SECRET",
      value: "x",
      isSecret: true,
      exportToEnv: true,
    });
    expect(optedIn.exportToEnv).toBe(true);
  });

  test("restricted keys store false and reject true through DB, HTTP, and MCP", async () => {
    const key = "SLACK_SIGNING_SECRET";
    const stored = await upsertSwarmConfig({ scope: "global", key, value: "s", isSecret: true });
    expect(stored.exportToEnv).toBe(false);
    const connection = await upsertSwarmConfig({
      scope: "global",
      key: "connection.example.secret",
      value: "s",
      isSecret: true,
    });
    expect(connection.exportToEnv).toBe(false);

    const body = { scope: "global" as const, key, value: "s", isSecret: true, exportToEnv: true };
    await expect(upsertSwarmConfig(body)).rejects.toThrow(envExportRestrictedError(key));

    const res = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: envExportRestrictedError(key) });

    const result = (await mcpServer.handlers.get("set-config")!(body, requestInfo)) as {
      structuredContent: { success: boolean; message: string };
    };
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(envExportRestrictedError(key));

    const [row] = await getSwarmConfigs({ key });
    expect(row?.exportToEnv).toBe(false);
  });

  test("the speech-to-text key never exports, even from an older stored true", async () => {
    const key = "TRANSCRIPTION_API_KEY";
    const stored = await upsertSwarmConfig({ scope: "global", key, value: "t", isSecret: true });
    expect(stored.exportToEnv).toBe(false);
    await expect(
      upsertSwarmConfig({ scope: "global", key, value: "t", isSecret: true, exportToEnv: true }),
    ).rejects.toThrow(envExportRestrictedError(key));
    expect(effectiveExportToEnv(key, true)).toBe(false);
  });

  test("the config API and /api/config/resolved carry the flag", async () => {
    const put = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        key: "EXPORT_B",
        value: "b",
        isSecret: true,
        exportToEnv: false,
      }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ key: "EXPORT_B", exportToEnv: false });

    const resolved = await fetch(`${baseUrl}/api/config/resolved?key=EXPORT_B`);
    const { configs } = (await resolved.json()) as {
      configs: Array<{ key: string; exportToEnv: boolean }>;
    };
    expect(configs).toEqual([expect.objectContaining({ key: "EXPORT_B", exportToEnv: false })]);
  });

  test("set-config accepts the flag and keeps it on a later write", async () => {
    const handler = mcpServer.handlers.get("set-config")!;
    await handler(
      { scope: "global", key: "EXPORT_C", value: "c", isSecret: true, exportToEnv: false },
      requestInfo,
    );
    await handler({ scope: "global", key: "EXPORT_C", value: "c2", isSecret: true }, requestInfo);
    const [row] = await getSwarmConfigs({ key: "EXPORT_C" });
    expect(row?.exportToEnv).toBe(false);
  });
});

describe("migration 215", () => {
  // Keys agents read from their own env today (PR #2156 review audit, plus
  // harness, git and agent-fs credentials). None may land on the deny list.
  const MUST_STAY_EXPORTED = [
    "AGENTMAIL_API_KEY",
    "ATTIO_API_KEY",
    "DOKPLOY_API_KEY",
    "ELEVENLABS_API_KEY",
    "EXA_API_KEY",
    "GSC_SERVICE_ACCOUNT_BASE64",
    "HETZNER_API_KEY",
    "IMGFLIP_PASSWORD",
    "IMGFLIP_USERNAME",
    "KAPSO_API_KEY",
    "PLAUSIBLE_API_KEY",
    "SPRITES_API_KEY",
    "SUPERAGENT_API_KEY",
    "TURSO_API_TOKEN",
    "TURSO_DB_TOKEN",
    "TURSO_X_POSTS_DB_TOKEN",
    "WORKDIR_API_KEY",
    "X_ACCESS_TOKEN",
    "X_ACCESS_TOKEN_SECRET",
    "X_API_KEY",
    "X_API_SECRET",
    "X_BEARER_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENROUTER_API_KEY",
    "GITHUB_TOKEN",
    "AGENT_FS_API_KEY",
    "SLACK_BOT_TOKEN",
    "SELF_DRIVING_WEBHOOK_SECRET",
    "DESPLEGA_PROD_DATABASE_URL",
    "GWS_CREDS_BASE64",
    "codex_oauth_1",
  ];
  const DENY_ONLY = [
    "KAPSO_WEBHOOK_HMAC_SECRET",
    "SENTRY_TEST_APP_WEBHOOK_SECRET",
    "TELEMETRY_CH_AUTH",
    "HACK_AGENT_FS_ADMIN_KEY",
    "X_CLIENT_SECRET",
    "connection.example.secret",
  ];
  // Restricted after migration 215 shipped. Row readers force the flag off
  // (effectiveExportToEnv), so an older stored true never reaches an agent.
  const RESTRICTED_AFTER_215 = new Set(["TRANSCRIPTION_API_KEY", "BITBUCKET_WEBHOOK_SECRET"]);
  const RESTRICTED_AT_215 = [...ENV_EXPORT_RESTRICTED_KEYS].filter(
    (key) => !RESTRICTED_AFTER_215.has(key),
  );

  test("backfills true and turns off only the deny list", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE swarm_config (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, scopeId TEXT, key TEXT NOT NULL,
        value TEXT NOT NULL, isSecret INTEGER NOT NULL DEFAULT 0, envPath TEXT,
        description TEXT, createdAt TEXT NOT NULL, lastUpdatedAt TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0)`);
      const insert = db.prepare(
        "INSERT INTO swarm_config (id, scope, key, value, isSecret, createdAt, lastUpdatedAt) VALUES (?, 'global', ?, 'v', 1, 'now', 'now')",
      );
      const keys = [...MUST_STAY_EXPORTED, ...DENY_ONLY, ...RESTRICTED_AT_215];
      for (const key of keys) insert.run(crypto.randomUUID(), key);

      db.exec(readFileSync(MIGRATION, "utf8"));

      const flags = Object.fromEntries(
        db
          .query<{ key: string; exportToEnv: number }, []>(
            "SELECT key, exportToEnv FROM swarm_config",
          )
          .all()
          .map((row) => [row.key, row.exportToEnv]),
      );
      for (const key of MUST_STAY_EXPORTED) expect([key, flags[key]]).toEqual([key, 1]);
      for (const key of [...DENY_ONLY, ...RESTRICTED_AT_215]) {
        expect([key, flags[key]]).toEqual([key, 0]);
      }
    } finally {
      db.close();
    }
  });
});
