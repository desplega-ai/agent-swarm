import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, initDb, upsertKv } from "../be/db";
import { upsertCodexDeviceFlow } from "../be/db/codex-oauth-device-flows";
import {
  DbQueryDeniedTableError,
  executeReadOnlyQueryGated,
  handleDbQuery,
} from "../http/db-query";
import { executeReadOnlyQuery } from "../http/db-query-shared";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

// A real on-disk database: the bounded path spawns a child process that opens
// its own connection, so an in-memory test template would be invisible to it.
const DB_PATH = join(tmpdir(), `db-query-denylist-${process.pid}-${Date.now()}.sqlite`);

const testGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
};
let savedTemplate: Uint8Array | undefined;

// Built at runtime so no secret-shaped literal lands in the repo.
const syntheticToken = () => `gh${"p"}_${"K".repeat(36)}`;

async function removeDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(`${DB_PATH}${suffix}`).delete();
    } catch {}
  }
}

beforeAll(async () => {
  savedTemplate = testGlobals.__testMigrationTemplate;
  testGlobals.__testMigrationTemplate = undefined;
  closeDb();
  await removeDb();
  initDb(DB_PATH);
  const db = getDb();
  db.run("CREATE VIEW denylist_test_view AS SELECT * FROM oauth_authorizations");
  db.run("CREATE TABLE denylist_test_notes (id INTEGER PRIMARY KEY, body TEXT)");
  db.run("INSERT INTO denylist_test_notes (body) VALUES (?)", [
    `deploy used ${syntheticToken()} from the env dump`,
  ]);
});

afterAll(async () => {
  closeDb();
  testGlobals.__testMigrationTemplate = savedTemplate;
  await removeDb();
});

const DENIED_QUERIES: Array<[string, string, string]> = [
  ["direct read", "SELECT * FROM oauth_authorizations", "oauth_authorizations"],
  ["alias", "SELECT a.accessToken FROM oauth_authorizations AS a", "oauth_authorizations"],
  ["CTE", "WITH t AS (SELECT * FROM oauth_authorizations) SELECT * FROM t", "oauth_authorizations"],
  [
    "join",
    "SELECT n.body, p.codeVerifier FROM denylist_test_notes n JOIN oauth_pending p ON 1 = 1",
    "oauth_pending",
  ],
  ["subquery", "SELECT * FROM (SELECT * FROM user_tokens)", "user_tokens"],
  ["view", "SELECT * FROM denylist_test_view", "oauth_authorizations"],
  ["scalar subquery", "SELECT (SELECT clientSecret FROM oauth_apps LIMIT 1) AS s", "oauth_apps"],
  ["count only", "SELECT COUNT(*) FROM session_tokens", "session_tokens"],
  ["mixed case", "select * from Script_Apis", "script_apis"],
];

describe("db-query credential-table denylist", () => {
  for (const [label, sql, table] of DENIED_QUERIES) {
    test(`in-process path rejects a ${label}`, () => {
      expect(() => executeReadOnlyQuery(sql)).toThrow(DbQueryDeniedTableError);
      expect(() => executeReadOnlyQuery(sql)).toThrow(table);
    });
  }

  test("bounded path rejects before spawning a child", async () => {
    for (const [, sql, table] of DENIED_QUERIES) {
      await expect(executeReadOnlyQueryGated(sql, [], 5_000, 10)).rejects.toThrow(table);
    }
  });

  test("allows swarm_config, EXPLAIN and a table name in a string literal", async () => {
    const config = await executeReadOnlyQueryGated("SELECT key FROM swarm_config", [], 5_000, 10);
    expect(config.columns).toEqual(["key"]);

    const explained = executeReadOnlyQuery("EXPLAIN QUERY PLAN SELECT * FROM oauth_authorizations");
    expect(explained.columns.length).toBeGreaterThan(0);

    const literal = executeReadOnlyQuery("SELECT 'oauth_authorizations' AS name");
    expect(literal.rows).toEqual([["oauth_authorizations"]]);
  });
});

describe("POST /api/db-query", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    server = createHttpServer(async (req, res) => {
      const handled = await handleDbQuery(
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(sql: string) {
    const res = await fetch(`${baseUrl}/api/db-query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  test("rejects a credential table with a clear 400", async () => {
    const { status, body } = await post("SELECT * FROM oauth_authorizations");
    expect(status).toBe(400);
    expect(String(body.error)).toContain("oauth_authorizations");
    expect(String(body.error)).toContain("credentials");
  });

  test("redacts a secret stored in an allowed table and keeps the context", async () => {
    const { status, body } = await post("SELECT body FROM denylist_test_notes");
    expect(status).toBe(200);
    const serialized = JSON.stringify(body.rows);
    expect(serialized).not.toContain(syntheticToken());
    expect(serialized).toContain("[REDACTED:");
    expect(serialized).toContain("from the env dump");
  });

  test("denies Codex device-login state and keeps general KV readable", async () => {
    const marker = `device-state-${crypto.randomUUID()}`;
    await upsertCodexDeviceFlow({
      flowId: crypto.randomUUID(),
      state: marker,
      expiresAt: Date.now() + 60_000,
    });
    await upsertKv({
      namespace: "denylist-test",
      key: "note",
      value: "plain kv value",
      valueType: "string",
    });

    for (const sql of [
      "SELECT * FROM codex_oauth_device_flows",
      "SELECT f.state FROM codex_oauth_device_flows f JOIN kv_entries k ON 1",
    ]) {
      const { status, body } = await post(sql);
      expect(status).toBe(400);
      expect(String(body.error)).toContain("codex_oauth_device_flows");
      expect(JSON.stringify(body)).not.toContain(marker);
    }

    const kv = await post("SELECT namespace, value FROM kv_entries");
    expect(kv.status).toBe(200);
    const rows = JSON.stringify(kv.body.rows);
    expect(rows).toContain("plain kv value");
    expect(rows).not.toContain("codex-oauth-device");
    expect(rows).not.toContain(marker);
  });

  test("migration 198 moves legacy kv device flows out of kv_entries", async () => {
    const flowId = crypto.randomUUID();
    const marker = `legacy-state-${crypto.randomUUID()}`;
    await upsertKv({
      namespace: "codex-oauth-device",
      key: flowId,
      value: marker,
      valueType: "string",
      expiresAt: Date.now() + 60_000,
    });
    const migration = await Bun.file(
      join(import.meta.dir, "../be/migrations/198_codex_oauth_device_flows.sql"),
    ).text();
    getDb().exec(migration);

    const kv = await post("SELECT key FROM kv_entries WHERE namespace = 'codex-oauth-device'");
    expect(kv.status).toBe(200);
    expect(kv.body.rows).toEqual([]);
    const moved = getDb()
      .query("SELECT state FROM codex_oauth_device_flows WHERE flow_id = ?")
      .get(flowId) as { state: string } | null;
    expect(moved?.state).toBe(marker);
  });
});
