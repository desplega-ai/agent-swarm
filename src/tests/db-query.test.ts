import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  __resetSqliteVecExtensionPathCacheForTests,
  closeDb,
  getDb,
  initDb,
  resolveSqliteVecExtensionPath,
} from "../be/db";
import {
  DbQueryInputSchema,
  executeReadOnlyQueryGated,
  handleDbQuery,
  resolveDbQuerySql,
} from "../http/db-query";
import { executeReadOnlyQueryBounded, isReportableTimeout } from "../http/db-query-bounded";
import {
  getDbQueryConcurrencyCap,
  getDbQueryHttpBudgetMs,
  getDbQueryHttpMaxRows,
  getDbQueryMcpBudgetMs,
  getDbQueryMcpMaxRows,
  resetDbQueryBoundedWarningForTests,
  resetDbQuerySpawnUnavailableWarningForTests,
} from "../http/db-query-shared";
import { getPathSegments, parseQueryParams } from "../http/utils";

describe("db-query input compatibility", () => {
  test("canonical sql input resolves to sql", () => {
    const parsed = DbQueryInputSchema.parse({ sql: "SELECT 1", params: [] });

    expect(resolveDbQuerySql(parsed)).toBe("SELECT 1");
  });

  test("legacy query input remains a runtime alias", () => {
    const parsed = DbQueryInputSchema.parse({ query: "SELECT 2" });

    expect(resolveDbQuerySql(parsed)).toBe("SELECT 2");
  });

  test("sql takes precedence when both sql and query are present", () => {
    const parsed = DbQueryInputSchema.parse({ sql: "SELECT 3", query: "SELECT 4" });

    expect(resolveDbQuerySql(parsed)).toBe("SELECT 3");
  });

  test("rejects input without sql or query", () => {
    const parsed = DbQueryInputSchema.safeParse({});

    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — bounded child-process execution (proposal §5.1, Tests A-F).
// Needs a real on-disk database: the bounded path spawns a separate `bun -e`
// process that opens its own connection, so an in-memory/deserialized test
// template (invisible outside this process) won't work. This swaps out the
// fast in-memory `__testMigrationTemplate` for a real file for the duration
// of this describe block, following the pattern in asset-key-migration.test.ts.
// ---------------------------------------------------------------------------

const BOUNDED_TEST_DB_PATH = "./test-db-query-bounded.sqlite";
const HTTP_TEST_PORT = 13097;

// A CPU-bound query with near-zero fixture setup cost (no table/data needed)
// and deterministic timing that doesn't depend on disk cache state, unlike
// the proposal's own I/O-bound synthetic table. Reliably takes >1s in this
// sandbox; must stay a SELECT so the read-only guard lets it through.
const SLOW_QUERY = `
  WITH RECURSIVE cnt(x) AS (
    SELECT 1
    UNION ALL
    SELECT x + 1 FROM cnt WHERE x < 6000000
  )
  SELECT COUNT(*) AS c FROM cnt WHERE (x * x) % 998244353 = 12345
`;

const boundedTestGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedDbQueryBoundedTemplate?: Uint8Array;
};

/** Starts handleDbQuery on HTTP_TEST_PORT for the duration of `fn`, exposing a small `post` helper. */
async function withDbQueryHttpServer<T>(
  fn: (post: (body: unknown) => Promise<{ status: number; body: DbQueryHttpBody }>) => Promise<T>,
): Promise<T> {
  let server: Server | undefined;
  try {
    server = createHttpServer(async (req, res) => {
      const pathSegments = getPathSegments(req.url || "");
      const queryParams = parseQueryParams(req.url || "");
      const handled = await handleDbQuery(req, res, pathSegments, queryParams);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server?.listen(HTTP_TEST_PORT, () => resolve()));

    const post = async (body: unknown) => {
      const res = await fetch(`http://localhost:${HTTP_TEST_PORT}/api/db-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as DbQueryHttpBody };
    };
    return await fn(post);
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
}

interface DbQueryHttpBody {
  rows?: unknown[][];
  total?: number;
  error?: string;
  message?: string;
}

/** Env keys the flag/budget-override tests touch — reset after each so tests don't leak into each other. */
const DB_QUERY_OVERRIDE_ENV_KEYS = [
  "DB_QUERY_BOUNDED_ENABLED",
  "DB_QUERY_HTTP_BUDGET_MS",
  "DB_QUERY_HTTP_MAX_ROWS",
  "DB_QUERY_MCP_BUDGET_MS",
  "DB_QUERY_MCP_MAX_ROWS",
  "DB_QUERY_CONCURRENCY_CAP",
] as const;

async function removeBoundedTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(`${BOUNDED_TEST_DB_PATH}${suffix}`).delete();
    } catch {}
  }
}

describe("db-query bounded execution (Fix 1)", () => {
  beforeAll(async () => {
    boundedTestGlobals.__savedDbQueryBoundedTemplate = boundedTestGlobals.__testMigrationTemplate;
    boundedTestGlobals.__testMigrationTemplate = undefined;
    closeDb();
    await removeBoundedTestDb();
    initDb(BOUNDED_TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    boundedTestGlobals.__testMigrationTemplate = boundedTestGlobals.__savedDbQueryBoundedTemplate;
    boundedTestGlobals.__savedDbQueryBoundedTemplate = undefined;
    await removeBoundedTestDb();
  });

  afterEach(() => {
    for (const key of DB_QUERY_OVERRIDE_ENV_KEYS) delete process.env[key];
    resetDbQueryBoundedWarningForTests();
    resetDbQuerySpawnUnavailableWarningForTests();
  });

  // Test A: budget is enforced — fails today because there is no budget
  // parameter or timeout path; the synchronous call only returns after the
  // full scan.
  test("A: rejects with a timeout error once the budget expires, well under 1s wall time", async () => {
    const start = performance.now();
    await expect(executeReadOnlyQueryBounded(SLOW_QUERY, [], 200)).rejects.toThrow(/budget/i);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  // Test B: the event loop stays responsive — fails today because the
  // interval fires about once regardless of query duration. This is the
  // assertion that encodes the actual defect.
  test("B: keeps a 50ms heartbeat ticking at close to its expected rate while the child runs", async () => {
    const heartbeatMs = 50;
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks++;
    }, heartbeatMs);

    const start = performance.now();
    await executeReadOnlyQueryBounded(SLOW_QUERY, [], 10_000);
    const elapsed = performance.now() - start;
    clearInterval(heartbeat);

    const expectedTicks = elapsed / heartbeatMs;
    expect(ticks).toBeGreaterThanOrEqual(expectedTicks * 0.6);
  });

  // Review round 3, thread 3814484703 (Oscar): the concurrency cap
  // (acquireBoundedQuerySlot/releaseBoundedQuerySlot in db-query-bounded.ts)
  // had no coverage. acquireBoundedQuerySlot() runs synchronously, before the
  // child process is even spawned, so firing DB_QUERY_CONCURRENCY_CAP + 1
  // calls back-to-back (no await between them) guarantees all cap checks run
  // in one JS tick, in order — no real query slowness is needed to keep every
  // slot "occupied" at the moment of the check, so a cheap query keeps this
  // deterministic instead of racing 9 concurrent CPU-heavy child processes
  // against the sandbox's resources (a SLOW_QUERY-based version of this test
  // was flaky here: concurrent recursive-CTE children intermittently hit
  // "database is locked" or got signal-killed under load). Exactly one call
  // must be rejected with the cap error, the other DB_QUERY_CONCURRENCY_CAP
  // must resolve. The regression this guards against is subtle — swap
  // acquire/try ordering, or drop the finally, and the cap silently becomes a
  // permanent lockout after one rejection instead of a transient one, which
  // the final assertion below catches.
  test("O: concurrency cap rejects exactly one caller past the limit, and releases slots once all settle", async () => {
    const cap = getDbQueryConcurrencyCap();
    const calls = Array.from({ length: cap + 1 }, () =>
      executeReadOnlyQueryBounded("SELECT 1", [], 10_000),
    );
    const settled = await Promise.allSettled(calls);

    const rejected = settled.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    const fulfilled = settled.filter((outcome) => outcome.status === "fulfilled");
    expect(rejected.length).toBe(1);
    expect(fulfilled.length).toBe(cap);
    expect((rejected[0].reason as Error).message).toMatch(/Too many concurrent/);

    // The assertion Oscar said he'd insist on: slots are released, not
    // permanently consumed by the rejection above. A caller landing here
    // after the batch settles must succeed normally.
    const result = await executeReadOnlyQueryBounded("SELECT 1", [], 10_000);
    expect(result.rows.length).toBe(1);
  });

  // Review round 3, thread 3814484711 (Oscar): neither half of
  // `isReportableTimeout`'s `timedOut && !(exitCode === 0 && stdout.length >
  // 0)` was pinned. Test A already asserts the /budget/i message for a
  // genuinely killed child (timedOut=true, non-zero exit) — that is the
  // second case Oscar named, covered without duplicating it here. Unit-test
  // the extracted predicate directly rather than racing real process timing
  // (the completion-vs-kill race is not reproducible on demand): this pins
  // both branches deterministically, including the exact boundary — a
  // fired timer whose child still produced a clean, non-empty result must
  // not be reported as a timeout.
  describe("isReportableTimeout (src/http/db-query-bounded.ts)", () => {
    test("a fired timer with a clean, non-empty result is not a timeout", () => {
      expect(isReportableTimeout(true, 0, '{"columns":[],"rows":[]}')).toBe(false);
    });

    test("a fired timer with no successful output is a timeout", () => {
      expect(isReportableTimeout(true, 1, "")).toBe(true);
    });

    test("a fired timer with exit code 0 but empty stdout is still a timeout", () => {
      expect(isReportableTimeout(true, 0, "")).toBe(true);
    });

    test("the timer never firing is never a timeout, regardless of exit code", () => {
      expect(isReportableTimeout(false, 1, "")).toBe(false);
    });
  });

  // Test C: `total` semantics do not move — this is the regression guard for
  // src/tools/db-query.ts:41 and src/http/metrics.ts:168, which compare
  // `total` against the delivered row count to compute `truncated`. Must
  // keep passing: the bounded path materializes fully before capping, same
  // as the synchronous path.
  test("C: total reflects rows returned, not rows delivered, when capped", async () => {
    const db = getDb();
    db.run("CREATE TABLE cap_test (id INTEGER PRIMARY KEY)");
    const insert = db.prepare("INSERT INTO cap_test DEFAULT VALUES");
    for (let i = 0; i < 250; i++) insert.run();

    const result = await executeReadOnlyQueryBounded("SELECT id FROM cap_test", [], 5000, 100);
    expect(result.total).toBe(250);
    expect(result.rows.length).toBe(100);
  });

  // Test D: Codex review, PR #1192 thread 3815732008 — before this fix, the
  // child mapped and JSON.stringified every matched row before the parent
  // ever saw `maxRows`, then the parent sliced the already-serialized array.
  // A query against a large table transferred and parsed a payload sized by
  // the full match count, not by maxRows, even though both callers always
  // supply one. The child now caps `rowArrays` before serializing (see
  // CHILD_SCRIPT in db-query-bounded.ts) — this pins that at a scale where
  // the two behave differently: `total` keeps the full match count, but the
  // array that actually crosses the child/parent boundary is bounded by
  // maxRows.
  test("D: caps the serialized payload at maxRows, not at the full match count, for a large result set", async () => {
    const db = getDb();
    db.run("CREATE TABLE codex_cap_test (id INTEGER PRIMARY KEY)");
    const insert = db.prepare("INSERT INTO codex_cap_test DEFAULT VALUES");
    for (let i = 0; i < 20_000; i++) insert.run();

    const result = await executeReadOnlyQueryBounded("SELECT id FROM codex_cap_test", [], 5000, 3);
    expect(result.total).toBe(20_000);
    expect(result.rows).toEqual([[1], [2], [3]]);
  });

  // Test T: Codex review, PR #1192 thread 3816302384 — bun:sqlite returns a
  // BLOB column (e.g. memories.embedding) as a Uint8Array, but JSON.stringify
  // on a Uint8Array serializes it as an indexed object ({"0":1,"1":2,...}),
  // not a real array, since TypedArrays have no toJSON. Before the fix, the
  // parent's JSON.parse handed the MCP table renderer that indexed object,
  // and `String(v)` on it produced "[object Object]" instead of the
  // comma-joined byte list a raw Uint8Array's own String() produces. The
  // child now converts BLOB values to a plain Array before writing stdout, so
  // `String()` on the round-tripped value matches `String()` on the original
  // bytes.
  test("T: BLOB columns round-trip as byte arrays, not JSON-object mush, across the child boundary", async () => {
    const db = getDb();
    db.run("CREATE TABLE blob_test (id INTEGER PRIMARY KEY, payload BLOB)");
    const bytes = new Uint8Array([1, 2, 255, 0, 128]);
    db.prepare("INSERT INTO blob_test (id, payload) VALUES (1, ?)").run(bytes);

    const result = await executeReadOnlyQueryBounded("SELECT payload FROM blob_test", [], 5000);
    const [payload] = result.rows[0] as [unknown];

    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toEqual(Array.from(bytes));
    expect(String(payload)).toBe(String(bytes));
    expect(String(payload)).not.toBe("[object Object]");
  });

  // Test E: the read-only guard survives the new path — passes today via a
  // different code path (the synchronous columnNames check); must keep
  // passing with the exact same error message through the child process.
  test("E: rejects a write with the exact pre-existing error message", async () => {
    const db = getDb();
    db.run("CREATE TABLE guard_test (id INTEGER PRIMARY KEY)");

    await expect(executeReadOnlyQueryBounded("DELETE FROM guard_test", [], 5000)).rejects.toThrow(
      "Only read-only queries are allowed",
    );
  });

  // Test F: the HTTP route is capped — fails today because
  // src/http/db-query.ts's handler passes no cap at all, so every row comes
  // back.
  test("F: /api/db-query caps rows at the new default and still reports the true total", async () => {
    const db = getDb();
    db.run("CREATE TABLE http_cap_test (id INTEGER PRIMARY KEY)");
    const insert = db.prepare("INSERT INTO http_cap_test DEFAULT VALUES");
    for (let i = 0; i < 1500; i++) insert.run();

    let server: Server | undefined;
    try {
      server = createHttpServer(async (req, res) => {
        const pathSegments = getPathSegments(req.url || "");
        const queryParams = parseQueryParams(req.url || "");
        const handled = await handleDbQuery(req, res, pathSegments, queryParams);
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((resolve) => server?.listen(HTTP_TEST_PORT, () => resolve()));

      const res = await fetch(`http://localhost:${HTTP_TEST_PORT}/api/db-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT id FROM http_cap_test", params: [] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: unknown[][]; total: number };
      expect(body.rows.length).toBe(1000);
      expect(body.total).toBeGreaterThan(1000);
    } finally {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    }
  });

  // Regression guard for src/http/db-query-bounded.ts:148-150 — a non-write
  // error must propagate the child's stderr as-is, not just the
  // WRITE_REJECTED_EXIT_CODE path (Test E already covers that one).
  // Reviewer 2's non-blocking suggestion on PR #87.
  test("N: propagates the child's stderr on a non-write, non-zero exit (a SQL error)", async () => {
    await expect(
      executeReadOnlyQueryBounded("SELECT * FROM this_table_does_not_exist_xyz", [], 5000),
    ).rejects.toThrow(/no such table/i);
  });

  // Test P: Codex review, PR #1192 thread 3815732016 — the standalone
  // `dist/agent-swarm` binary (`bun run build:binary`) embeds the Bun
  // runtime for its own execution but does not bundle a separate spawnable
  // `bun` binary, so Bun.spawn(["bun", ...]) throws "Executable not found in
  // $PATH" on a host that lacks one. Falls back to the synchronous
  // in-process path instead of failing every db-query outright.
  test("P: falls back to the synchronous in-process path when no bun executable can be spawned", async () => {
    const originalSpawn = Bun.spawn;
    Bun.spawn = (() => {
      throw new Error('Executable not found in $PATH: "bun"');
    }) as typeof Bun.spawn;

    try {
      const result = await executeReadOnlyQueryBounded("SELECT 1 AS one", [], 5000);
      expect(result.rows).toEqual([[1]]);
      expect(result.total).toBe(1);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  // Test Q: the spawn-failure fallback above must not swallow an unrelated
  // spawn error (e.g. a resource-exhaustion condition) by silently routing
  // it to the unbounded in-process path — only a missing-executable error
  // should trigger the fallback.
  test("Q: does not swallow a genuine spawn error unrelated to a missing executable", async () => {
    const originalSpawn = Bun.spawn;
    Bun.spawn = (() => {
      throw new Error("EMFILE: too many open files");
    }) as typeof Bun.spawn;

    try {
      await expect(executeReadOnlyQueryBounded("SELECT 1", [], 5000)).rejects.toThrow(
        "EMFILE: too many open files",
      );
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  // -------------------------------------------------------------------------
  // Feature-flag addendum (follow-up to Fix 1, PR #87): DB_QUERY_BOUNDED_ENABLED
  // kill switch + DB_QUERY_HTTP_BUDGET_MS / DB_QUERY_HTTP_MAX_ROWS /
  // DB_QUERY_MCP_BUDGET_MS overrides. See the plan doc addendum for the design.
  // -------------------------------------------------------------------------

  test("defaults apply when unset, and an invalid override falls back to the default", () => {
    expect(getDbQueryHttpBudgetMs()).toBe(10_000);
    expect(getDbQueryHttpMaxRows()).toBe(1000);
    expect(getDbQueryMcpBudgetMs()).toBe(5_000);
    expect(getDbQueryMcpMaxRows()).toBe(100);

    process.env.DB_QUERY_HTTP_BUDGET_MS = "-5";
    expect(getDbQueryHttpBudgetMs()).toBe(10_000);

    process.env.DB_QUERY_HTTP_MAX_ROWS = "not-a-number";
    expect(getDbQueryHttpMaxRows()).toBe(1000);

    process.env.DB_QUERY_MCP_MAX_ROWS = "not-a-number";
    expect(getDbQueryMcpMaxRows()).toBe(100);
  });

  // Review round 4 (desplega-bot, pullrequestreview-4975616777), non-blocking
  // item on db-query-shared.ts:55: readPositiveIntEnv read raw process.env
  // directly, bypassing the `^\d+$` integer-only check
  // swarm-config-guard.ts's integerValidators applies to the same keys when
  // set through swarm_config — a fraction or a value past Node/Bun's 32-bit
  // setTimeout limit set directly as an env var sailed through and could
  // fire the timer almost immediately instead of waiting that long. These
  // are exactly the "direct-env" cases the DB-backed validator can't catch.
  test("a fractional budget is rejected, not truncated", () => {
    process.env.DB_QUERY_HTTP_BUDGET_MS = "500.5";
    expect(getDbQueryHttpBudgetMs()).toBe(10_000);

    process.env.DB_QUERY_MCP_BUDGET_MS = "5000.9";
    expect(getDbQueryMcpBudgetMs()).toBe(5_000);
  });

  test("a budget above Node/Bun's 32-bit setTimeout limit falls back to the default", () => {
    process.env.DB_QUERY_HTTP_BUDGET_MS = "9999999999";
    expect(getDbQueryHttpBudgetMs()).toBe(10_000);
  });

  test("a budget exactly at the 32-bit setTimeout limit is accepted", () => {
    process.env.DB_QUERY_HTTP_BUDGET_MS = "2147483647";
    expect(getDbQueryHttpBudgetMs()).toBe(2_147_483_647);
  });

  // G: flag ON (default, unset) — the gate still runs the bounded path and
  // enforces the budget, same as calling executeReadOnlyQueryBounded directly.
  test("G: gated executor runs the bounded path by default and still enforces the budget", async () => {
    await expect(executeReadOnlyQueryGated(SLOW_QUERY, [], 200)).rejects.toThrow(/budget/i);
  });

  // H: flag explicitly "true" behaves the same as unset.
  test("H: DB_QUERY_BOUNDED_ENABLED=true behaves the same as unset", async () => {
    process.env.DB_QUERY_BOUNDED_ENABLED = "true";
    await expect(executeReadOnlyQueryGated(SLOW_QUERY, [], 200)).rejects.toThrow(/budget/i);
  });

  // I: flag OFF — the gate must fall back to the legacy, unbounded in-process
  // path. A budget that would trip the bounded path must be ignored entirely,
  // not just extended, and the query must complete normally.
  test("I: DB_QUERY_BOUNDED_ENABLED=false runs the legacy in-process path, ignoring the budget", async () => {
    process.env.DB_QUERY_BOUNDED_ENABLED = "false";
    const result = await executeReadOnlyQueryGated(SLOW_QUERY, [], 200);
    expect(result.rows.length).toBe(1);
  });

  // J: HTTP route, flag OFF — still caps rows via the legacy path (the cap is
  // applied by executeReadOnlyQuery too, not just the bounded executor), and
  // must not throw despite a budget that would trip the bounded path.
  test("J: /api/db-query with DB_QUERY_BOUNDED_ENABLED=false still caps rows via the legacy path", async () => {
    process.env.DB_QUERY_BOUNDED_ENABLED = "false";
    process.env.DB_QUERY_HTTP_BUDGET_MS = "1";

    const { status, body } = await withDbQueryHttpServer((post) =>
      post({ sql: "SELECT id FROM http_cap_test", params: [] }),
    );
    expect(status).toBe(200);
    expect(body.rows?.length).toBe(1000);
    expect(body.total).toBeGreaterThan(1000);
  });

  // K: DB_QUERY_HTTP_BUDGET_MS actually reaches the bounded executor via the
  // HTTP route — a tightened budget trips the timeout on a query that would
  // otherwise pass under the 10s default. Review round 4 (desplega-bot,
  // pullrequestreview-4975616777): a timeout must return a distinct,
  // documented status (408) with a stable machine-readable code, not the
  // same 400 every other error on this route returns.
  test("K: DB_QUERY_HTTP_BUDGET_MS overrides the bounded HTTP budget, returning a distinct 408", async () => {
    process.env.DB_QUERY_HTTP_BUDGET_MS = "150";
    expect(getDbQueryHttpBudgetMs()).toBe(150);

    const { status, body } = await withDbQueryHttpServer((post) =>
      post({ sql: SLOW_QUERY, params: [] }),
    );
    expect(status).toBe(408);
    expect(body.error).toBe("db_query_timeout");
    expect(body.message).toMatch(/150ms budget/);
  });

  // Review round 4 (desplega-bot, pullrequestreview-4975616777): the
  // concurrency cap was also collapsed into the generic 400. Saturate the
  // cap with slots that never release (SELECT 1 calls made without an
  // `await` between them so the acquire checks all run in the same tick —
  // same technique as test O), then confirm the one HTTP call that lands on
  // top gets 429 with a stable code and a Retry-After header instead of 400.
  test("caps saturation via the HTTP route returns 429 with a stable code and Retry-After", async () => {
    const fillers = Array.from({ length: getDbQueryConcurrencyCap() }, () =>
      executeReadOnlyQueryBounded("SELECT 1", [], 10_000),
    );

    const { status, headers, body } = await withDbQueryHttpServer(async (_post) => {
      const res = await fetch(`http://localhost:${HTTP_TEST_PORT}/api/db-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1", params: [] }),
      });
      return {
        status: res.status,
        headers: res.headers,
        body: (await res.json()) as DbQueryHttpBody,
      };
    });

    expect(status).toBe(429);
    expect(body.error).toBe("db_query_concurrency_cap");
    expect(headers.get("retry-after")).not.toBeNull();

    await Promise.allSettled(fillers);
  });

  // L: DB_QUERY_HTTP_MAX_ROWS actually reaches the HTTP route's row cap.
  test("L: DB_QUERY_HTTP_MAX_ROWS overrides the HTTP row cap", async () => {
    process.env.DB_QUERY_HTTP_MAX_ROWS = "5";
    expect(getDbQueryHttpMaxRows()).toBe(5);

    const { status, body } = await withDbQueryHttpServer((post) =>
      post({ sql: "SELECT id FROM http_cap_test", params: [] }),
    );
    expect(status).toBe(200);
    expect(body.rows?.length).toBe(5);
    expect(body.total).toBeGreaterThan(5);
  });

  // M: DB_QUERY_MCP_BUDGET_MS actually reaches the bounded executor on the
  // MCP tool's path (same gated executor the HTTP route uses, with the MCP
  // budget getter instead of the HTTP one).
  test("M: DB_QUERY_MCP_BUDGET_MS overrides the MCP query budget", async () => {
    process.env.DB_QUERY_MCP_BUDGET_MS = "150";
    expect(getDbQueryMcpBudgetMs()).toBe(150);

    await expect(
      executeReadOnlyQueryGated(SLOW_QUERY, [], getDbQueryMcpBudgetMs()),
    ).rejects.toThrow(/150ms budget/);
  });

  // U: Codex review, PR #1192 thread 3816146995 — the concurrency cap must be
  // an operator-tunable knob, not a hardcoded constant, so a deployment with
  // more headroom than the 1 GiB default sizing assumes can raise it (and one
  // with less can lower it) without a code change.
  test("U: DB_QUERY_CONCURRENCY_CAP overrides the concurrency cap", async () => {
    process.env.DB_QUERY_CONCURRENCY_CAP = "2";
    expect(getDbQueryConcurrencyCap()).toBe(2);

    const calls = Array.from({ length: 3 }, () =>
      executeReadOnlyQueryBounded("SELECT 1", [], 10_000),
    );
    const settled = await Promise.allSettled(calls);
    const rejected = settled.filter((outcome) => outcome.status === "rejected");
    expect(rejected.length).toBe(1);
  });

  // V: review round 3 (tarasyarema, threads 3819136863/3819139208) — the MCP
  // tool's row cap was a hardcoded 100 with no operator override, unlike every
  // other budget/cap this PR made tunable. DB_QUERY_MCP_MAX_ROWS must actually
  // reach the gated executor the MCP tool calls, the same way L proves
  // DB_QUERY_HTTP_MAX_ROWS reaches the HTTP route's row cap.
  test("V: DB_QUERY_MCP_MAX_ROWS overrides the MCP row cap", async () => {
    process.env.DB_QUERY_MCP_MAX_ROWS = "5";
    expect(getDbQueryMcpMaxRows()).toBe(5);

    const result = await executeReadOnlyQueryGated(
      "SELECT id FROM http_cap_test",
      [],
      getDbQueryMcpBudgetMs(),
      getDbQueryMcpMaxRows(),
    );
    expect(result.rows.length).toBe(5);
    expect(result.total).toBeGreaterThan(5);
  });

  // Review round 4 (desplega-bot, pullrequestreview-4975616777), non-blocking
  // item on db-query-bounded.ts:58: the child's read-only connection set no
  // busy_timeout at all (SQLite's default is 0 — SQLITE_BUSY fails
  // immediately on any lock), independent of the wall-clock budget the
  // caller asked for. The child now sets `PRAGMA busy_timeout` to the same
  // budgetMs used for the parent's SIGKILL timer. Exercised with a real
  // lock: `PRAGMA locking_mode=EXCLUSIVE` is the one way to force a genuine
  // SQLITE_BUSY against a *reader* (ordinary WAL writers don't block WAL
  // readers, which is the whole point of WAL — only an exclusive
  // OS-level lock does). The writer releases well inside the query's
  // budget; the bounded query must wait for it and succeed, which fails
  // under the pre-fix code (no busy_timeout means an immediate "database is
  // locked" instead of a wait).
  //
  // A true cross-process lock-contention integration test (a second
  // connection holding an exclusive lock, released mid-wait) was tried and
  // dropped: `locking_mode=EXCLUSIVE`'s release only takes effect on that
  // connection's *next* statement, and the child is a separate OS process
  // spawned via Bun.spawn, so its wait time is dominated by process-spawn
  // overhead rather than the lock — measured elapsed times were inconsistent
  // by 100s of ms across runs in this sandbox, i.e. exactly the kind of
  // flaky timing-based test SOUL.md rules out. Test the actual code change
  // instead: intercept Bun.spawn and assert the child's payload carries
  // `busyTimeoutMs` equal to the caller's `budgetMs`, not a fixed value.
  // SQLite honoring `PRAGMA busy_timeout` is documented upstream behavior,
  // not something this PR needs to re-prove.
  test("R: the child's busy_timeout is bound to the query's budgetMs, not a fixed value", async () => {
    const originalSpawn = Bun.spawn;
    let capturedPayload: { busyTimeoutMs?: number } = {};

    Bun.spawn = ((): unknown => {
      let written = "";
      return {
        stdin: {
          write: (data: string) => {
            written += data;
          },
          end: async () => {
            capturedPayload = JSON.parse(written);
          },
        },
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ columns: ["one"], rows: [[1]], elapsed: 0, total: 1 }),
              ),
            );
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }) as typeof Bun.spawn;

    try {
      await executeReadOnlyQueryBounded("SELECT 1", [], 4321);
      expect(capturedPayload.busyTimeoutMs).toBe(4321);

      await executeReadOnlyQueryBounded("SELECT 1", [], 777);
      expect(capturedPayload.busyTimeoutMs).toBe(777);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  // Same review thread — "cover ... a post-timeout write/checkpoint" was the
  // second half of the ask: prove a SIGKILLed child doesn't leave the WAL in
  // a state that blocks a later writer. Force a genuine timeout (tight
  // budget against SLOW_QUERY, already proven to SIGKILL the child in test
  // A), then perform an ordinary write and a full checkpoint against the
  // same on-disk file.
  test("S: a write and checkpoint succeed normally right after a bounded query is killed", async () => {
    await expect(executeReadOnlyQueryBounded(SLOW_QUERY, [], 200)).rejects.toThrow(/budget/i);

    const db = getDb();
    db.run("CREATE TABLE IF NOT EXISTS post_timeout_write (id INTEGER PRIMARY KEY)");
    db.run("INSERT INTO post_timeout_write DEFAULT VALUES");
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    expect(checkpoint.busy).toBe(0);
  });
});

// Review round 3, thread 3814484715 (Oscar): __resetSqliteVecExtensionPathCacheForTests
// had no caller outside its own definition. Oscar's preference, which we're
// following: write the test that needs the helper rather than drop it —
// resolve once, mutate the env var, resolve again and assert the cached
// value survives, then reset and assert the new value is picked up. This
// also pins the "a resolved `undefined` is cached too" doc comment: the
// mechanism is a `null`-sentinel check with no branching on the cached
// value's type, so the same two assertions hold regardless of whether the
// first resolution lands on a path string or `undefined`.
describe("resolveSqliteVecExtensionPath memoization (src/be/db.ts)", () => {
  const ORIGINAL_EXTENSION_PATH_ENV = process.env.SQLITE_VEC_EXTENSION_PATH;

  afterEach(() => {
    if (ORIGINAL_EXTENSION_PATH_ENV === undefined) {
      delete process.env.SQLITE_VEC_EXTENSION_PATH;
    } else {
      process.env.SQLITE_VEC_EXTENSION_PATH = ORIGINAL_EXTENSION_PATH_ENV;
    }
    __resetSqliteVecExtensionPathCacheForTests();
  });

  test("caches the resolved path across calls, surviving a later env var change", () => {
    __resetSqliteVecExtensionPathCacheForTests();
    process.env.SQLITE_VEC_EXTENSION_PATH = "/tmp/first-vec-path.so";
    expect(resolveSqliteVecExtensionPath()).toBe("/tmp/first-vec-path.so");

    process.env.SQLITE_VEC_EXTENSION_PATH = "/tmp/second-vec-path.so";
    expect(resolveSqliteVecExtensionPath()).toBe("/tmp/first-vec-path.so");
  });

  test("resetting the cache picks up the new env var value", () => {
    __resetSqliteVecExtensionPathCacheForTests();
    process.env.SQLITE_VEC_EXTENSION_PATH = "/tmp/first-vec-path.so";
    resolveSqliteVecExtensionPath();

    process.env.SQLITE_VEC_EXTENSION_PATH = "/tmp/second-vec-path.so";
    __resetSqliteVecExtensionPathCacheForTests();
    expect(resolveSqliteVecExtensionPath()).toBe("/tmp/second-vec-path.so");
  });
});
