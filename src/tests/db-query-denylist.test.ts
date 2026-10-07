import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, initDb } from "../be/db";
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
});
