import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createUser,
  createWorkflow,
  createWorkflowRun,
  deleteUser,
  getDb,
  getDbClient,
  getWorkflowRun,
  initDb,
  updateWorkflowRun,
} from "../be/db";
import {
  USER_REFERENCE_COLUMNS_SQL,
  type UserReferenceRow,
  userReferenceRewriteSql,
  WORKFLOW_CONTEXT_REMOVE_REQUESTER_SQL,
  WORKFLOW_CONTEXT_SET_REQUESTER_SQL,
  WORKFLOW_SEALED_CONTEXT_BY_REQUESTER_SQL,
} from "../be/db/user-references";
import { openSealedJson } from "../be/sealed-json";

// Incident 2026-11-09: merging two users ran deleteUser on an 85 GB prod DB
// and every UPDATE on the large audit tables scanned the full table while the
// workflow_runs JSON passes parsed the context of all 493k rows. The API froze
// for 278 s. Migration 319 indexes the user FK columns and the context
// requester expression. These tests explain the exact statements deleteUser
// runs (src/be/db/user-references.ts) and pin every plan to an index.

const TEST_DB_PATH = `./test-user-delete-perf-${crypto.randomUUID()}.sqlite`;

interface ExplainRow {
  detail: string;
}

/** Table/column pairs that dominated the incident timings. */
const HEAVY_COLUMNS: Array<[table: string, column: string]> = [
  ["workflow_runs", "created_by"],
  ["workflow_runs", "updated_by"],
  ["workflow_run_steps", "created_by"],
  ["workflow_run_steps", "updated_by"],
  ["script_runs", "created_by"],
  ["script_runs", "updated_by"],
  ["script_runs", "requestedByUserId"],
  ["kv_entries", "created_by"],
  ["kv_entries", "updated_by"],
  ["page_versions", "created_by"],
  ["page_versions", "updated_by"],
  ["agent_memory", "created_by"],
  ["agent_memory", "updated_by"],
  ["asset_key_history", "changed_by"],
];

/**
 * `EXPLAIN QUERY PLAN <write>` read with `.all()` on a cached bun:sqlite statement
 * leaves the connection holding an active write statement, and COMMIT then fails
 * with SQLITE_BUSY ("SQL statements in progress"). The db client retries that
 * with 25 ms..500 ms backoffs, so the next deleteUser stalled for ~1.4 s locally
 * and past the 10 s test timeout on CI. Read the plan from a statement this
 * helper finalizes.
 */
function explainRows(sql: string, params: string[]): ExplainRow[] {
  const stmt = getDb().query<ExplainRow, string[]>(`EXPLAIN QUERY PLAN ${sql}`);
  try {
    return stmt.all(...params);
  } finally {
    stmt.finalize();
  }
}

async function explain(sql: string, params: string[]): Promise<string> {
  return explainRows(sql, params)
    .map((row) => row.detail)
    .join(" | ");
}

/**
 * Records every statement the process sends to bun:sqlite while fn runs. The
 * db client funnels get / query / run through Database.prototype.query, so
 * this sees the SQL deleteUser executes, not a copy of it.
 */
async function recordStatements(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const original = Database.prototype.query;
  Database.prototype.query = function patched(this: Database, sql: string, ...rest: unknown[]) {
    seen.push(sql);
    return (original as (this: Database, sql: string, ...rest: unknown[]) => unknown).call(
      this,
      sql,
      ...rest,
    );
  } as typeof Database.prototype.query;
  try {
    await fn();
  } finally {
    Database.prototype.query = original;
  }
  return seen;
}

/** Explains a recorded statement with one placeholder value per `?`. */
async function explainRecorded(sql: string): Promise<string[]> {
  const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => "x");
  return explainRows(sql, params).map((row) => row.detail);
}

async function runRequestedBy(
  userId: string,
  opts: { createdBy?: string | null } = {},
): Promise<string> {
  const workflow = await createWorkflow({
    name: `delete-perf-${crypto.randomUUID()}`,
    definition: { nodes: [] },
  });
  const runId = crypto.randomUUID();
  await createWorkflowRun({
    id: runId,
    workflowId: workflow.id,
    triggerType: "manual",
    createdBy: opts.createdBy === undefined ? userId : (opts.createdBy ?? undefined),
  });
  await updateWorkflowRun(runId, {
    status: "running",
    context: { swarm: { requestedByUserId: userId }, input: { key: "value" } },
  });
  return runId;
}

async function storedColumns(
  runId: string,
): Promise<{ created_by: string | null; context: string; context_replay: string }> {
  const row = await getDbClient().get<{
    created_by: string | null;
    context: string;
    context_replay: string;
  }>("SELECT created_by, context, context_replay FROM workflow_runs WHERE id = ?", [runId]);
  if (!row) throw new Error(`run ${runId} missing`);
  return row;
}

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
});

describe("deleteUser query plans", () => {
  // Regression: a plan read that leaves a statement active makes the next
  // deleteUser transaction retry its COMMIT on SQLITE_BUSY for seconds.
  afterEach(() => {
    const db = getDb();
    db.run("BEGIN IMMEDIATE");
    try {
      expect(() => db.run("COMMIT")).not.toThrow();
    } finally {
      if (db.inTransaction) db.run("ROLLBACK");
    }
  });

  test("the discovery query returns every heavy column", async () => {
    const references = await getDbClient().query<UserReferenceRow>(USER_REFERENCE_COLUMNS_SQL);
    const pairs = new Set(references.map((r) => `${r.tableName}.${r.columnName}`));
    for (const [table, column] of HEAVY_COLUMNS) {
      expect(pairs.has(`${table}.${column}`)).toBe(true);
    }
  });

  test("every write statement a real deleteUser executes searches an index", async () => {
    const source = await createUser({ name: "spy source" });
    const target = await createUser({ name: "spy target" });
    await runRequestedBy(source.id);
    const references = await getDbClient().query<UserReferenceRow>(USER_REFERENCE_COLUMNS_SQL);

    const statements = await recordStatements(async () => {
      expect(await deleteUser(source.id, target.id)).toBe(true);
    });

    const rewrites = statements.filter((sql) => /^\s*UPDATE\s/i.test(sql));
    const sealedSelects = statements.filter((sql) => /context_replay FROM workflow_runs/.test(sql));
    const deletes = statements.filter((sql) => /^\s*DELETE FROM users\b/i.test(sql));
    // Every discovered column, the context json_set, and the sealed replay copy.
    expect(rewrites.length).toBeGreaterThanOrEqual(references.length + 2);
    expect(sealedSelects.length).toBe(1);
    expect(deletes.length).toBe(1);

    const scans: string[] = [];
    for (const sql of [...rewrites, ...sealedSelects, ...deletes]) {
      const plan = await explainRecorded(sql);
      if (plan.some((detail) => detail.startsWith("SCAN"))) {
        scans.push(`${sql.replace(/\s+/g, " ").trim().slice(0, 120)} => ${plan.join(" | ")}`);
      }
    }
    expect(scans).toEqual([]);
    expect(
      sealedSelects.concat(rewrites.filter((sql) => /json_set|json_remove/.test(sql))).length,
    ).toBe(2);
  });

  test("every discovered column rewrite searches an index", async () => {
    const references = await getDbClient().query<UserReferenceRow>(USER_REFERENCE_COLUMNS_SQL);
    expect(references.length).toBeGreaterThan(HEAVY_COLUMNS.length);
    const scans: string[] = [];
    for (const reference of references) {
      const detail = await explain(userReferenceRewriteSql(reference), ["replacement", "source"]);
      if (!/SEARCH \S+ USING (COVERING )?INDEX/.test(detail) || /\bSCAN\b/.test(detail)) {
        scans.push(`${reference.tableName}.${reference.columnName}: ${detail}`);
      }
    }
    expect(scans).toEqual([]);
  });

  for (const [table, column] of HEAVY_COLUMNS) {
    test(`UPDATE ${table}.${column} uses idx_${table}_${column}`, async () => {
      const detail = await explain(
        userReferenceRewriteSql({ tableName: table, columnName: column }),
        ["replacement", "source"],
      );
      expect(detail).toMatch(
        new RegExp(`SEARCH ${table} USING (COVERING )?INDEX idx_${table}_${column}`),
      );
    });
  }

  test("the sealed-context SELECT searches the context requester index", async () => {
    const detail = await explain(WORKFLOW_SEALED_CONTEXT_BY_REQUESTER_SQL, ["source"]);
    expect(detail).toMatch(/SEARCH workflow_runs USING INDEX idx_workflow_runs_context_requester/);
    expect(detail).not.toMatch(/SCAN workflow_runs/);
  });

  test("the context json_set and json_remove UPDATEs search the context requester index", async () => {
    for (const [sql, params] of [
      [WORKFLOW_CONTEXT_SET_REQUESTER_SQL, ["replacement", "source"]],
      [WORKFLOW_CONTEXT_REMOVE_REQUESTER_SQL, ["source"]],
    ] as const) {
      const detail = await explain(sql, [...params]);
      expect(detail).toMatch(
        /SEARCH workflow_runs USING INDEX idx_workflow_runs_context_requester/,
      );
      expect(detail).not.toMatch(/SCAN workflow_runs/);
    }
  });

  test("DELETE FROM users runs its FK parent-delete checks without a table scan", async () => {
    // A partial index with an unrelated predicate does not count: session_shares_user
    // (migration 230, WHERE revokedAt IS NULL) left SCAN session_shares in this plan
    // until migration 319 added idx_session_shares_userId.
    const rows = explainRows("DELETE FROM users WHERE id = ?", ["source"]);
    const scans = rows.map((row) => row.detail).filter((detail) => detail.startsWith("SCAN"));
    expect(scans).toEqual([]);
  });
});

describe("deleteUser workflow context rewrite", () => {
  test("a merge rewrites created_by, context and the sealed replay copy to the replacement", async () => {
    const source = await createUser({ name: "merge source" });
    const target = await createUser({ name: "merge target" });
    const bystander = await createUser({ name: "bystander" });
    const runId = await runRequestedBy(source.id);
    const otherRunId = await runRequestedBy(bystander.id);

    expect(await deleteUser(source.id, target.id)).toBe(true);

    const stored = await storedColumns(runId);
    expect(stored.created_by).toBe(target.id);
    expect(JSON.parse(stored.context).swarm).toEqual({ requestedByUserId: target.id });
    expect((openSealedJson(stored.context_replay) as { swarm: unknown }).swarm).toEqual({
      requestedByUserId: target.id,
    });
    expect((await getWorkflowRun(runId))?.context?.swarm).toEqual({
      requestedByUserId: target.id,
    });

    const other = await storedColumns(otherRunId);
    expect(other.created_by).toBe(bystander.id);
    expect(JSON.parse(other.context).swarm).toEqual({ requestedByUserId: bystander.id });
  });

  test("a merge rewrites the context requester even when created_by names another user or nobody", async () => {
    // created_by and context.swarm.requestedByUserId can disagree: legacy runs
    // predate created_by, and a node whose id is "swarm" can overwrite ctx.swarm.
    // The rewrite must find the run through the context, not through created_by.
    const source = await createUser({ name: "context-only source" });
    const target = await createUser({ name: "context-only target" });
    const creator = await createUser({ name: "different creator" });
    const legacyRunId = await runRequestedBy(source.id, { createdBy: null });
    const mismatchRunId = await runRequestedBy(source.id, { createdBy: creator.id });

    expect(await deleteUser(source.id, target.id)).toBe(true);

    for (const runId of [legacyRunId, mismatchRunId]) {
      const stored = await storedColumns(runId);
      expect(JSON.parse(stored.context).swarm).toEqual({ requestedByUserId: target.id });
      expect((openSealedJson(stored.context_replay) as { swarm: unknown }).swarm).toEqual({
        requestedByUserId: target.id,
      });
    }
    expect((await storedColumns(legacyRunId)).created_by).toBeNull();
    expect((await storedColumns(mismatchRunId)).created_by).toBe(creator.id);
  });

  test("a delete without a replacement clears created_by and removes the requester from both copies", async () => {
    const source = await createUser({ name: "plain delete" });
    const runId = await runRequestedBy(source.id);

    expect(await deleteUser(source.id)).toBe(true);

    const stored = await storedColumns(runId);
    expect(stored.created_by).toBeNull();
    const context = JSON.parse(stored.context);
    expect(context.swarm).toEqual({});
    expect(context.input).toEqual({ key: "value" });
    const replay = openSealedJson(stored.context_replay) as { swarm: Record<string, unknown> };
    expect(replay.swarm).toEqual({});
    expect((await getWorkflowRun(runId))?.context?.swarm).toEqual({});
  });

  test("a run with malformed context JSON neither breaks the indexed lookup nor matches it", async () => {
    const source = await createUser({ name: "malformed neighbour source" });
    const target = await createUser({ name: "malformed neighbour target" });
    const runId = await runRequestedBy(source.id);
    const brokenRunId = await runRequestedBy(source.id);
    // Bypass the API so the stored context is not valid JSON; the CASE guard in
    // the index expression must yield NULL here instead of raising.
    await getDbClient().run("UPDATE workflow_runs SET context = ? WHERE id = ?", [
      "{not json",
      brokenRunId,
    ]);

    expect(await deleteUser(source.id, target.id)).toBe(true);

    expect(JSON.parse((await storedColumns(runId)).context).swarm).toEqual({
      requestedByUserId: target.id,
    });
    expect((await storedColumns(brokenRunId)).context).toBe("{not json");
  });
});
