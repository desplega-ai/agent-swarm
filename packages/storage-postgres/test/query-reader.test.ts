import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DB_QUERY_DENIED_TABLES,
  type QueryReader,
  QueryReaderDeniedError,
  QueryReaderNotQueryError,
  QueryReaderTimeoutError,
} from "@desplega/storage";
import { openPostgresQueryReader } from "../src/query-reader";
import { createScratchDatabase, type ScratchDatabase } from "./scratch";

/**
 * Decision D10: the db-query reader logs in as a restricted role. The probe
 * refuses a role that can read a denied table (directly or through a view),
 * can write, owns objects or can run a SECURITY DEFINER function.
 */

const DENIED = [...DB_QUERY_DENIED_TABLES];
let db: ScratchDatabase;
let admin: InstanceType<typeof Bun.SQL>;
const role = `st_reader_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

function readerUrl(): string {
  const url = new URL(db.url);
  url.username = role;
  // A password, not trust: CI's Postgres image requires scram over TCP.
  url.password = role;
  return url.toString();
}

async function probeReason(): Promise<string | null> {
  const result = await openPostgresQueryReader(readerUrl(), DENIED);
  if (result.ok) {
    await result.reader.close();
    return null;
  }
  return result.reason;
}

beforeAll(async () => {
  db = await createScratchDatabase("qreader");
  admin = new Bun.SQL(db.url);
  await admin.unsafe(
    `CREATE TABLE agents (id text PRIMARY KEY, "isLead" boolean, data jsonb, n bigint, at timestamptz)`,
  );
  for (const table of DENIED) await admin.unsafe(`CREATE TABLE ${table} (id text, secret text)`);
  await admin.unsafe(
    `INSERT INTO agents VALUES ('a1', true, '{"k":1}', 42, '2026-11-20T10:00:00Z'), ('a2', false, NULL, 2, NULL)`,
  );
  await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${role}'`);
  await admin.unsafe(`GRANT CONNECT ON DATABASE ${db.name} TO ${role}`);
  await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await admin.unsafe(`GRANT SELECT ON agents TO ${role}`);
});

afterAll(async () => {
  await admin.close();
  await db.drop();
  const cleanup = new Bun.SQL(db.url.replace(/\/[^/]+$/, "/postgres"));
  try {
    await cleanup.unsafe(`DROP ROLE IF EXISTS ${role}`);
  } finally {
    await cleanup.close();
  }
});

describe("db-query reader probe", () => {
  test("a malformed reader URL turns the reader off instead of throwing", async () => {
    const result = await openPostgresQueryReader("postgres://reader@host:99999999/db", DENIED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid reader URL");
  });

  test("a superuser fails the probe", async () => {
    const result = await openPostgresQueryReader(db.url, DENIED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("superuser");
  });

  test("a SELECT-only role without the denied tables passes", async () => {
    expect(await probeReason()).toBeNull();
  });

  test("SELECT on a denied table fails the probe", async () => {
    await admin.unsafe(`GRANT SELECT ON user_tokens TO ${role}`);
    try {
      expect(await probeReason()).toContain("user_tokens");
    } finally {
      await admin.unsafe(`REVOKE SELECT ON user_tokens FROM ${role}`);
    }
  });

  test("a column grant on a denied table fails the probe", async () => {
    await admin.unsafe(`GRANT SELECT (id) ON session_tokens TO ${role}`);
    try {
      expect(await probeReason()).toContain("session_tokens");
    } finally {
      await admin.unsafe(`REVOKE SELECT (id) ON session_tokens FROM ${role}`);
    }
  });

  test("a readable view over a denied table, through another view, fails the probe", async () => {
    await admin.unsafe(`CREATE VIEW inner_leak AS SELECT secret FROM oauth_apps`);
    await admin.unsafe(`CREATE VIEW outer_leak AS SELECT * FROM inner_leak`);
    await admin.unsafe(`GRANT SELECT ON outer_leak TO ${role}`);
    try {
      expect(await probeReason()).toContain("outer_leak");
    } finally {
      await admin.unsafe(`DROP VIEW outer_leak, inner_leak`);
    }
  });

  test("a write grant fails the probe", async () => {
    await admin.unsafe(`GRANT UPDATE ON agents TO ${role}`);
    try {
      expect(await probeReason()).toContain("can write");
    } finally {
      await admin.unsafe(`REVOKE UPDATE ON agents FROM ${role}`);
    }
  });

  test("an executable SECURITY DEFINER function fails the probe", async () => {
    await admin.unsafe(
      `CREATE FUNCTION leak_fn() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS 'SELECT count(*) FROM user_tokens'`,
    );
    try {
      expect(await probeReason()).toContain("SECURITY DEFINER");
    } finally {
      await admin.unsafe(`DROP FUNCTION leak_fn()`);
    }
  });

  test("CREATE on the schema fails the probe", async () => {
    await admin.unsafe(`GRANT CREATE ON SCHEMA public TO ${role}`);
    try {
      expect(await probeReason()).toContain("create objects");
    } finally {
      await admin.unsafe(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
    }
  });
});

describe("db-query reader queries", () => {
  let reader: QueryReader;
  beforeAll(async () => {
    const result = await openPostgresQueryReader(readerUrl(), DENIED);
    if (!result.ok) throw new Error(result.reason);
    reader = result.reader;
  });
  afterAll(async () => {
    await reader.close();
  });

  test("returns columns, rows and the full total past maxRows", async () => {
    const result = await reader.run(
      `SELECT id, "isLead", data, n, at FROM agents WHERE id <> $1 OR $1 IS NULL ORDER BY id`,
      ["none"],
      { budgetMs: 5_000, maxRows: 1 },
    );
    expect(result.columns).toEqual(["id", "isLead", "data", "n", "at"]);
    expect(result.total).toBe(2);
    expect(result.rows).toEqual([["a1", 1, '{"k":1}', 42, "2026-11-20T10:00:00.000Z"]]);
  });

  test("a denied table maps to QueryReaderDeniedError", async () => {
    await expect(
      reader.run("SELECT * FROM agents JOIN script_apis USING (id)", [], { budgetMs: 5_000 }),
    ).rejects.toBeInstanceOf(QueryReaderDeniedError);
  });

  test("a write is refused (only queries open a cursor)", async () => {
    await expect(
      reader.run(`UPDATE agents SET n = 0`, [], { budgetMs: 5_000 }),
    ).rejects.toBeInstanceOf(QueryReaderNotQueryError);
    await expect(
      reader.run(`  DELETE FROM agents`, [], { budgetMs: 5_000 }),
    ).rejects.toBeInstanceOf(QueryReaderNotQueryError);
    await expect(
      reader.run(`WITH d AS (DELETE FROM agents RETURNING id) SELECT * FROM d`, [], {
        budgetMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(QueryReaderNotQueryError);
    const syntax = await reader.run(`SELECT 1 FROM`, [], { budgetMs: 5_000 }).catch((e) => e);
    expect(syntax).toBeInstanceOf(Error);
    expect(syntax).not.toBeInstanceOf(QueryReaderNotQueryError);
    const [row] = (await admin.unsafe(`SELECT count(*)::int AS n FROM agents WHERE n <> 0`)) as {
      n: number;
    }[];
    expect(row?.n).toBe(2);
  });

  test("user SQL cannot lift the statement timeout", async () => {
    await expect(
      reader.run(`SELECT set_config('statement_timeout', '0', true), pg_sleep(3)`, [], {
        budgetMs: 300,
      }),
    ).rejects.toBeInstanceOf(QueryReaderTimeoutError);
  });
});
