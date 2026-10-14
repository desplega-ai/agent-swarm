import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { SQL } from "bun";
import { closeDb, createAgent, getDb, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import {
  getScriptApiConnectionDescriptors,
  getScriptApiTypes,
  getScriptConnectionById,
  setScriptConnectionEnabled,
  upsertScriptConnection,
} from "../be/script-connections";
import { buildScriptCredentialBindings } from "../be/script-credential-broker";
import { typecheckScript } from "../be/scripts/typecheck";
import {
  runReadOnlyQuery,
  SQL_MAX_BYTES,
  SQL_MAX_ROWS,
  setSqlExecutorForTesting,
} from "../be/sql-connections";
import { handleScriptConnectionProxy } from "../http/script-connection-proxy";
import { handleScriptConnections } from "../http/script-connections";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { createApiRegistryClient } from "../scripts-runtime/api-client";
import { runScript } from "../scripts-runtime/loader";
import { SwarmConfig } from "../scripts-runtime/swarm-config";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-script-connections-sql.sqlite";
const API_KEY = "example-test-script-connections-sql-key-1234567890";
const DSN = "postgres://reader:sql-conn-test-password-123@db.internal.test:5432/analytics";
const REAL_PG_URL = process.env.SQL_CONNECTION_TEST_URL;
const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

let leadId: string;
let workerId: string;
let executorCalls: Array<{ dsn: string; query: string; params: unknown[] }> = [];
const savedEnv = { ...process.env };

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function dispatch(
  path: string,
  init: { method?: string; body?: unknown; agentId?: string } = {},
): Promise<{ status: number; text: string; json: () => Record<string, unknown> }> {
  const req = Readable.from(
    init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body))],
  ) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = {
    "content-type": "application/json",
    ...(init.agentId ? { "x-agent-id": init.agentId } : {}),
  };
  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  const pathSegments = getPathSegments(path);
  const queryParams = parseQueryParams(path);
  const handled =
    (await handleScriptConnectionProxy(req, res, pathSegments, queryParams, init.agentId)) ||
    (await handleScriptConnections(req, res, pathSegments, queryParams, init.agentId));
  if (!handled) status = 404;
  return { status, text, json: () => JSON.parse(text) };
}

function registerSql(body: Record<string, unknown>, agentId = leadId) {
  return dispatch("/api/script-connections", {
    method: "POST",
    agentId,
    body: { kind: "sql", slug: "analytics", ...body },
  });
}

function sqlQuery(connectionId: string, agentId: string, body: Record<string, unknown>) {
  return dispatch(`/api/script-connections/${connectionId}/sql-query`, {
    method: "POST",
    agentId,
    body,
  });
}

async function configRows(key: string) {
  return getDbClient().query<{
    scope: string;
    scopeId: string | null;
    value: string;
    encrypted: number;
  }>("SELECT scope, scopeId, value, encrypted FROM swarm_config WHERE key = ?", [key]);
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  closeDb();
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  refreshSecretScrubberCache();
});

afterAll(async () => {
  setSqlExecutorForTesting(null);
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  refreshSecretScrubberCache();
});

beforeEach(async () => {
  const client = getDbClient();
  await client.run("DELETE FROM script_connections");
  await client.run("DELETE FROM script_credential_bindings");
  await client.run("DELETE FROM swarm_config");
  await client.run("DELETE FROM agents");
  leadId = (await createAgent({ name: "sql-lead", isLead: true, status: "idle" })).id;
  workerId = (await createAgent({ name: "sql-worker", isLead: false, status: "idle" })).id;
  executorCalls = [];
  setSqlExecutorForTesting(async (dsn, query, params, take) => {
    executorCalls.push({ dsn, query, params });
    take([{ x: 1 }]);
  });
});

describe("migration 213", () => {
  test("adds 'sql' to the kind CHECK and requires a DSN key for sql rows", async () => {
    const schema = getDb()
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'script_connections'",
      )
      .get();
    expect(schema?.sql).toContain("'graphql', 'sql'");
    await expect(
      getDbClient().run(
        "INSERT INTO script_connections (id, slug, kind) VALUES (?, 'no-key', 'sql')",
        [crypto.randomUUID()],
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  test("rebuild keeps existing rows, auth columns, and managed bindings", async () => {
    const graphql = await upsertScriptConnection({
      slug: "vendor",
      kind: "graphql",
      baseUrl: "https://vendor.example.test/graphql",
      allowedHosts: ["vendor.example.test"],
      auth: { type: "bearer", secret: "vendor-secret-value-123456" },
    });
    expect(graphql.credentialBindingId).not.toBeNull();
    const before = await getDbClient().query<Record<string, unknown>>(
      "SELECT * FROM script_connections ORDER BY id",
    );

    const db = getDb();
    db.run("PRAGMA foreign_keys = OFF");
    try {
      db.exec(
        readFileSync(
          new URL("../be/migrations/213_script_connections_sql.sql", import.meta.url),
          "utf-8",
        ),
      );
    } finally {
      db.run("PRAGMA foreign_keys = ON");
    }

    const after = await getDbClient().query<Record<string, unknown>>(
      "SELECT * FROM script_connections ORDER BY id",
    );
    expect(after).toEqual(before);
    expect(after[0]?.auth_type).toBe("bearer");
    expect(after[0]?.auth_config_key).toBe("connection.vendor.secret");
    const bindings = await getDbClient().query<{ id: string }>(
      "SELECT id FROM script_credential_bindings WHERE managed_by_connection_id = ?",
      [graphql.id],
    );
    expect(bindings.map((binding) => binding.id)).toEqual([graphql.credentialBindingId!]);
  });
});

describe("sql connection registration", () => {
  test("inline DSN is stored encrypted under connection.<slug>.secret and never echoed", async () => {
    const response = await registerSql({ dsn: { secret: DSN } });
    expect(response.status).toBe(200);
    expect(response.text).not.toContain("postgres://");
    const connection = (response.json().connection ?? {}) as Record<string, unknown>;
    expect(connection).toMatchObject({
      kind: "sql",
      authType: "none",
      authConfigKey: "connection.analytics.secret",
    });

    const rows = await configRows("connection.analytics.secret");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "global", encrypted: 1 });
    expect(rows[0]?.value).not.toContain("postgres://");

    const stored = await getScriptConnectionById(String(connection.id));
    expect(stored?.generatedRuntimeJson).not.toContain("postgres://");
    expect(JSON.parse(stored?.generatedRuntimeJson ?? "{}")).toEqual({
      slug: "analytics",
      kind: "sql",
      connectionId: connection.id,
    });

    const detail = await dispatch(`/api/script-connections/${connection.id}`, { agentId: leadId });
    const list = await dispatch("/api/script-connections", { agentId: leadId });
    expect(detail.status).toBe(200);
    expect(list.status).toBe(200);
    expect(detail.text).not.toContain("postgres://");
    expect(list.text).not.toContain("postgres://");
  });

  test("registration is lead-only", async () => {
    const response = await registerSql({ dsn: { secret: DSN } }, workerId);
    expect(response.status).toBe(403);
    expect(await configRows("connection.analytics.secret")).toHaveLength(0);
  });

  test("rejects a non-Postgres DSN without echoing it", async () => {
    for (const secret of ["sqlite:///var/lib/swarm/agent-swarm-db.sqlite", "not a url at all"]) {
      const response = await registerSql({ dsn: { secret } });
      expect(response.status).toBe(400);
      expect(response.text).toContain("postgres://");
      expect(response.text).not.toContain(secret);
    }
  });

  test("rejects inline auth, both or neither DSN fields, and reserved config keys", async () => {
    const auth = await registerSql({
      dsn: { secret: DSN },
      auth: { type: "bearer", secret: "token-value-1234567890" },
    });
    expect(auth.status).toBe(400);
    expect(auth.text).toContain("`auth` is not supported");

    const both = await registerSql({ dsn: { secret: DSN, configKey: "ANALYTICS_DSN" } });
    expect(both.status).toBe(400);
    const missing = await registerSql({});
    expect(missing.status).toBe(400);
    expect(missing.text).toContain("dsn.secret");

    const reserved = await registerSql({ dsn: { configKey: "connection.other.secret" } });
    expect(reserved.status).toBe(400);
    expect(reserved.text).toContain("reserved");
  });

  test("configKey DSN stores the key as-is", async () => {
    const response = await registerSql({ dsn: { configKey: "ANALYTICS_DSN" } });
    expect(response.status).toBe(200);
    expect(response.json().connection).toMatchObject({ authConfigKey: "ANALYTICS_DSN" });
    expect(await configRows("connection.analytics.secret")).toHaveLength(0);
  });

  test("edit without dsn keeps the key; a slug rename with a new DSN drops the old secret", async () => {
    const created = (await registerSql({ dsn: { secret: DSN } })).json().connection as {
      id: string;
    };
    const renamed = await registerSql({ id: created.id, slug: "warehouse", displayName: "WH" });
    expect(renamed.status).toBe(200);
    expect(renamed.json().connection).toMatchObject({
      slug: "warehouse",
      authConfigKey: "connection.analytics.secret",
    });
    expect(await configRows("connection.analytics.secret")).toHaveLength(1);

    const rekeyed = await registerSql({ id: created.id, slug: "warehouse", dsn: { secret: DSN } });
    expect(rekeyed.status).toBe(200);
    expect(rekeyed.json().connection).toMatchObject({
      authConfigKey: "connection.warehouse.secret",
    });
    expect(await configRows("connection.analytics.secret")).toHaveLength(0);
    expect(await configRows("connection.warehouse.secret")).toHaveLength(1);
  });

  test("descriptors and types expose ctx.api.<slug>.query and typecheck", async () => {
    const created = (await registerSql({ dsn: { secret: DSN } })).json().connection as {
      id: string;
    };
    expect(getScriptApiConnectionDescriptors({ agentId: workerId })).toContainEqual({
      slug: "analytics",
      kind: "sql",
      connectionId: created.id,
    });
    expect(getScriptApiTypes({ agentId: workerId })).toContain("query<T");

    const typecheck = await typecheckScript(
      `
        import type { ScriptMain } from "swarm-sdk";
        const main: ScriptMain = async (_args, ctx) => {
          const { rows, rowCount, truncated } = await ctx.api.analytics.query("select $1::int as x", [1]);
          return { rows, rowCount, truncated };
        };
        export default main;
      `,
      { agentId: workerId },
    );
    expect(typecheck).toEqual({ ok: true });
  });
});

describe("sql-query route", () => {
  async function createSql(extra: Partial<Parameters<typeof upsertScriptConnection>[0]> = {}) {
    return upsertScriptConnection({
      slug: "analytics",
      kind: "sql",
      sqlDsn: { secret: DSN },
      ...extra,
    });
  }

  test("a non-lead agent runs a query with the server-resolved DSN", async () => {
    const connection = await createSql();
    const response = await sqlQuery(connection.id, workerId, {
      sql: "select $1::int as x",
      params: [1],
    });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true, rows: [{ x: 1 }], rowCount: 1, truncated: false });
    expect(response.text).not.toContain("postgres://");
    expect(executorCalls).toEqual([{ dsn: DSN, query: "select $1::int as x", params: [1] }]);
  });

  test("gates: disabled, agent scope, wrong kind, unknown id", async () => {
    const connection = await createSql();
    await setScriptConnectionEnabled(connection.id, false);
    expect((await sqlQuery(connection.id, workerId, { sql: "select 1" })).status).toBe(403);

    const owned = await createSql({ slug: "owned", scope: "agent", scopeId: leadId });
    expect((await sqlQuery(owned.id, workerId, { sql: "select 1" })).status).toBe(403);

    const graphql = await upsertScriptConnection({
      slug: "vendor",
      kind: "graphql",
      baseUrl: "https://vendor.example.test/graphql",
      allowedHosts: ["vendor.example.test"],
    });
    expect((await sqlQuery(graphql.id, workerId, { sql: "select 1" })).status).toBe(400);
    const enabledSql = await createSql({ slug: "enabled" });
    const mcpCall = await dispatch(`/api/script-connections/${enabledSql.id}/mcp-call`, {
      method: "POST",
      agentId: workerId,
      body: { tool: "query" },
    });
    expect(mcpCall.status).toBe(400);
    expect((await sqlQuery(crypto.randomUUID(), workerId, { sql: "select 1" })).status).toBe(404);
    expect(executorCalls).toHaveLength(0);
  });

  test("repo-scoped connections resolve the repo-scope secret", async () => {
    const repoId = crypto.randomUUID();
    const connection = await createSql({ scope: "repo", scopeId: repoId });
    expect(await configRows("connection.analytics.secret")).toEqual([
      expect.objectContaining({ scope: "repo", scopeId: repoId }),
    ]);
    const response = await sqlQuery(connection.id, workerId, { sql: "select 1" });
    expect(response.json()).toMatchObject({ ok: true });
    expect(executorCalls[0]?.dsn).toBe(DSN);
  });

  test("never falls back to process.env for the DSN key", async () => {
    process.env.ANALYTICS_ENV_DSN = DSN;
    try {
      const connection = await createSql({ sqlDsn: { configKey: "ANALYTICS_ENV_DSN" } });
      const response = await sqlQuery(connection.id, workerId, { sql: "select 1" });
      expect(response.json()).toEqual({
        ok: false,
        error: "SQL connection DSN 'ANALYTICS_ENV_DSN' is not set.",
      });
      expect(executorCalls).toHaveLength(0);
    } finally {
      delete process.env.ANALYTICS_ENV_DSN;
    }
  });

  test("a stored non-Postgres DSN is refused before any connection", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "LOCAL_FILE_DSN",
      value: "sqlite:///tmp/agent-swarm-db.sqlite",
      isSecret: true,
    });
    const connection = await createSql({ sqlDsn: { configKey: "LOCAL_FILE_DSN" } });
    const response = await sqlQuery(connection.id, workerId, { sql: "select 1" });
    expect(response.json()).toMatchObject({ ok: false });
    expect(response.text).not.toContain("sqlite:///");
    expect(executorCalls).toHaveLength(0);
  });

  test("error text is scrubbed of the DSN and its password", async () => {
    const connection = await createSql();
    setSqlExecutorForTesting(async () => {
      throw new Error(`connect failed for ${DSN} (password sql-conn-test-password-123)`);
    });
    const response = await sqlQuery(connection.id, workerId, { sql: "select 1" });
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("[REDACTED");
    expect(response.text).not.toContain("sql-conn-test-password-123");
    expect(response.text).not.toContain("postgres://");
  });

  test("caps rows, stops fetching, and reports truncation", async () => {
    const connection = await createSql();
    const accepted: boolean[] = [];
    setSqlExecutorForTesting(async (_dsn, _query, _params, take) => {
      for (let b = 0; b < 20; b++) {
        const more = take(Array.from({ length: 100 }, (_, i) => ({ i: b * 100 + i })));
        accepted.push(more);
        if (!more) return;
      }
    });
    const body = (await sqlQuery(connection.id, workerId, { sql: "select 1" })).json();
    expect(body).toMatchObject({ ok: true, rowCount: SQL_MAX_ROWS, truncated: true });
    expect((body.rows as unknown[]).length).toBe(SQL_MAX_ROWS);
    expect(accepted).toEqual([...Array(10).fill(true), false]);
  });

  test("caps the serialized size and reports truncation", async () => {
    const connection = await createSql();
    const big = "x".repeat(1024 * 1024);
    setSqlExecutorForTesting(async (_dsn, _query, _params, take) => {
      take(Array.from({ length: 10 }, (_, i) => ({ i, big })));
    });
    const response = await sqlQuery(connection.id, workerId, { sql: "select 1" });
    const body = response.json();
    expect(body).toMatchObject({ ok: true, rowCount: 4, truncated: true });
    expect(response.text.length).toBeLessThan(SQL_MAX_BYTES + 1024);
  });
});

describe("ctx.api sql runtime", () => {
  test("query posts to the sql-query route as the script's agent", async () => {
    const calls: Array<{ url: string; agent: string | null; body: unknown }> = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        agent: new Headers(init?.headers).get("x-agent-id"),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ ok: true, rows: [{ x: 1 }], rowCount: 1, truncated: false });
    }) as typeof globalThis.fetch;
    try {
      const swarmConfig = new SwarmConfig({
        system: {
          apiKey: { value: API_KEY, isSecret: true },
          agentId: { value: "agent-runtime", isSecret: false },
          mcpBaseUrl: { value: "http://swarm.test/", isSecret: false },
        },
        user: {},
      });
      const api = createApiRegistryClient(
        [{ slug: "analytics", kind: "sql", connectionId: "conn-1" }],
        { swarmConfig },
      );
      expect(await api.analytics!.query!("select $1::int as x", [1])).toEqual({
        rows: [{ x: 1 }],
        rowCount: 1,
        truncated: false,
      });
      expect(calls).toEqual([
        {
          url: "http://swarm.test/api/script-connections/conn-1/sql-query",
          agent: "agent-runtime",
          body: { sql: "select $1::int as x", params: [1] },
        },
      ]);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  for (const executor of ["native", "quickjs"]) {
    spawnTest(`script round trip through the ${executor} executor`, async () => {
      const connection = await upsertScriptConnection({
        slug: "analytics",
        kind: "sql",
        sqlDsn: { secret: DSN },
      });
      const server = createServer((req, res) => {
        const url = req.url ?? "/";
        const agentId = req.headers["x-agent-id"] as string | undefined;
        void handleScriptConnectionProxy(
          req,
          res,
          getPathSegments(url),
          parseQueryParams(url),
          agentId,
        ).then((handled) => {
          if (!handled) res.writeHead(404).end();
        });
      });
      const port = await listenOnFreePort(server, "127.0.0.1");
      const savedExecutor = process.env.SCRIPT_EXECUTOR;
      process.env.SCRIPT_EXECUTOR = executor;
      try {
        const apiConnections = getScriptApiConnectionDescriptors({ agentId: workerId });
        const egressSecrets = await buildScriptCredentialBindings({ agentId: workerId });
        expect(JSON.stringify({ apiConnections, egressSecrets })).not.toContain("postgres://");
        const output = await runScript({
          agentId: workerId,
          mcpBaseUrl: `http://127.0.0.1:${port}`,
          apiConnections,
          egressSecrets,
          source: `
            export default async (_args, ctx) => ctx.api.analytics.query("select 1 as x");
          `,
        });
        expect(output.error).toBeUndefined();
        expect(output.result).toEqual({ rows: [{ x: 1 }], rowCount: 1, truncated: false });
        expect(executorCalls).toEqual([{ dsn: DSN, query: "select 1 as x", params: [] }]);
        expect(connection.kind).toBe("sql");
      } finally {
        if (savedExecutor === undefined) delete process.env.SCRIPT_EXECUTOR;
        else process.env.SCRIPT_EXECUTOR = savedExecutor;
        server.close();
      }
    });
  }
});

// Proves the read-only guarantee against a real Postgres. CI sets the URL from a postgres service
// in merge-gate.yml and ci.yml; locally it is opt-in.
// SQL_CONNECTION_TEST_URL=postgres://postgres:<pw>@127.0.0.1:55432/postgres
describe.skipIf(!REAL_PG_URL)("read-only against real Postgres", () => {
  const dsn = REAL_PG_URL ?? "";
  const table = "sql_conn_readonly_probe";
  const reader = "sql_conn_reader_probe";
  let admin: SQL;

  async function rowCount(): Promise<number> {
    const [row] = await admin.unsafe(`select count(*)::int as n from ${table}`);
    return (row as { n: number }).n;
  }

  async function sqlState(query: string, params: unknown[] = []): Promise<string> {
    setSqlExecutorForTesting(null);
    const err = await runReadOnlyQuery(dsn, query, params).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    return /SQLSTATE (\w+)/.exec(err?.message ?? "")?.[1] ?? "none";
  }

  beforeAll(async () => {
    admin = new SQL(dsn);
    await admin.unsafe(`drop table if exists ${table}`);
    await admin.unsafe(`create table ${table} (id serial primary key, v int)`);
    await admin.unsafe(`insert into ${table} (v) values (1), (2)`);
  });

  afterAll(async () => {
    await admin.unsafe(`drop table if exists ${table}`);
    await admin.unsafe(`drop owned by ${reader}`).catch(() => undefined);
    await admin.unsafe(`drop role if exists ${reader}`);
    await admin.close();
  });

  beforeEach(() => setSqlExecutorForTesting(null));

  test("select returns rows", async () => {
    const result = await runReadOnlyQuery(dsn, `select v from ${table} where v = $1`, [2]);
    expect(result).toEqual({ rows: [{ v: 2 }], rowCount: 1, truncated: false });
    expect(await runReadOnlyQuery(dsn, "select 1 as x")).toMatchObject({ rows: [{ x: 1 }] });
  });

  test("writes are refused by the cursor grammar or the read-only transaction", async () => {
    // 42601: DECLARE ... CURSOR FOR only takes a query. 0A000: no data-modifying WITH.
    // 25006: read_only_sql_transaction, for writes hidden inside a SELECT.
    expect(await sqlState(`insert into ${table} (v) values (3)`)).toBe("42601");
    expect(await sqlState(`insert into ${table} (v) values ($1)`, [3])).toBe("42601");
    expect(await sqlState(`update ${table} set v = 9`)).toBe("42601");
    expect(await sqlState(`delete from ${table}`)).toBe("42601");
    expect(await sqlState("create table sql_conn_should_not_exist (id int)")).toBe("42601");
    expect(await sqlState(`with d as (delete from ${table} returning *) select * from d`)).toBe(
      "0A000",
    );
    expect(await sqlState(`select nextval('${table}_id_seq')`)).toBe("25006");
    expect(await rowCount()).toBe(2);
  });

  test("the cursor stops at the row cap", async () => {
    expect(
      await runReadOnlyQuery(dsn, "select generate_series(1, $1::int) as i", [5000]),
    ).toMatchObject({
      rowCount: SQL_MAX_ROWS,
      truncated: true,
    });
    expect(
      await runReadOnlyQuery(dsn, `select generate_series(1, ${SQL_MAX_ROWS}) as i`),
    ).toMatchObject({ rowCount: SQL_MAX_ROWS, truncated: false });
  });

  test("multi-statement calls are rejected, with or without params", async () => {
    // 42601: "cannot insert multiple commands into a prepared statement".
    expect(await sqlState(`select 1; delete from ${table}`)).toBe("42601");
    expect(await sqlState(`select $1::int; delete from ${table}`, [1])).toBe("42601");
    expect(
      await sqlState(
        `commit; set default_transaction_read_only = off; commit; insert into ${table} (v) values (4)`,
      ),
    ).toBe("42601");
    expect(await rowCount()).toBe(2);
  });

  test("session state never carries into the next call", async () => {
    await runReadOnlyQuery(dsn, "set default_transaction_read_only = off").catch(() => undefined);
    await runReadOnlyQuery(dsn, "select set_config('default_transaction_read_only', 'off', false)");
    expect(await sqlState(`select nextval('${table}_id_seq')`)).toBe("25006");
    await runReadOnlyQuery(dsn, "select set_config('transaction_read_only', 'off', false)").catch(
      () => undefined,
    );
    expect(await sqlState(`select nextval('${table}_id_seq')`)).toBe("25006");
    expect(await rowCount()).toBe(2);
  });

  // The least-privilege role from the script-connections docs page.
  test("a SELECT-only role cannot reach server files or programs", async () => {
    await admin.unsafe(`drop owned by ${reader}`).catch(() => undefined);
    await admin.unsafe(`drop role if exists ${reader}`);
    await admin.unsafe(
      `create role ${reader} login password 'reader-probe-pw' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
    );
    await admin.unsafe(`alter role ${reader} set default_transaction_read_only = on`);
    await admin.unsafe(`grant usage on schema public to ${reader}`);
    await admin.unsafe(`grant select on ${table} to ${reader}`);
    const url = new URL(dsn);
    url.username = reader;
    url.password = "reader-probe-pw";
    const readerDsn = url.toString();

    expect(await runReadOnlyQuery(readerDsn, `select count(*)::int as n from ${table}`)).toEqual({
      rows: [{ n: 2 }],
      rowCount: 1,
      truncated: false,
    });
    const denied = async (query: string) => {
      const err = await runReadOnlyQuery(readerDsn, query).then(
        () => null,
        (e: Error) => e,
      );
      return /SQLSTATE (\w+)/.exec(err?.message ?? "")?.[1];
    };
    expect(await denied("select pg_read_file('/etc/hostname')")).toBe("42501");
    expect(await denied("select pg_ls_dir('.')")).toBe("42501");
  });
});
