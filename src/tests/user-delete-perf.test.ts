import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import {
  closeDb,
  createUser,
  createWorkflow,
  createWorkflowRun,
  deleteUser,
  getDbClient,
  getWorkflowRun,
  initDb,
  updateWorkflowRun,
} from "../be/db";
import { runMigrations } from "../be/migrations/runner";
import { openSealedJson } from "../be/sealed-json";

// Incident 2026-11-09: merging two users ran deleteUser on an 85 GB prod DB
// and every UPDATE on the large audit tables scanned the full table while the
// workflow_runs JSON passes parsed the context of all 493k rows. The API froze
// for 278 s. Migration 318 indexes the user FK columns and deleteUser narrows
// the JSON passes by created_by. These tests pin both via EXPLAIN QUERY PLAN.

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

async function explain(sql: string, params: string[]): Promise<string> {
  const rows = await getDbClient().query<ExplainRow>(`EXPLAIN QUERY PLAN ${sql}`, params);
  return rows.map((row) => row.detail).join(" | ");
}

async function runRequestedBy(userId: string): Promise<string> {
  const workflow = await createWorkflow({
    name: `delete-perf-${crypto.randomUUID()}`,
    definition: { nodes: [] },
  });
  const runId = crypto.randomUUID();
  // Mirrors src/workflows/engine.ts: created_by and context.swarm.requestedByUserId
  // come from the same requester.
  await createWorkflowRun({
    id: runId,
    workflowId: workflow.id,
    triggerType: "manual",
    createdBy: userId,
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
  for (const [table, column] of HEAVY_COLUMNS) {
    test(`UPDATE ${table}.${column} uses idx_${table}_${column}`, async () => {
      const detail = await explain(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`, [
        "replacement",
        "source",
      ]);
      expect(detail).toMatch(
        new RegExp(`SEARCH ${table} USING (COVERING )?INDEX idx_${table}_${column}`),
      );
      expect(detail).not.toMatch(new RegExp(`SCAN ${table}( |$)`));
    });
  }

  test("the sealed-context SELECT searches workflow_runs by created_by", async () => {
    const detail = await explain(
      `SELECT id, context_replay FROM workflow_runs
       WHERE created_by = ?
         AND context_replay IS NOT NULL
         AND json_valid(context)
         AND json_extract(context, '$.swarm.requestedByUserId') = ?`,
      ["source", "source"],
    );
    expect(detail).toMatch(/SEARCH workflow_runs USING INDEX idx_workflow_runs_created_by/);
    expect(detail).not.toMatch(/SCAN workflow_runs/);
  });

  test("the context json_set and json_remove UPDATEs search workflow_runs by created_by", async () => {
    for (const setter of [
      "json_set(context, '$.swarm.requestedByUserId', ?)",
      "json_remove(context, '$.swarm.requestedByUserId')",
    ]) {
      const params = setter.includes("?")
        ? ["replacement", "source", "source"]
        : ["source", "source"];
      const detail = await explain(
        `UPDATE workflow_runs
         SET context = ${setter}
         WHERE created_by = ?
           AND json_valid(context)
           AND json_extract(context, '$.swarm.requestedByUserId') = ?`,
        params,
      );
      expect(detail).toMatch(/SEARCH workflow_runs USING INDEX idx_workflow_runs_created_by/);
      expect(detail).not.toMatch(/SCAN workflow_runs/);
    }
  });
  test("DELETE FROM users runs its FK parent-delete checks without a table scan", async () => {
    // A partial index with an unrelated predicate does not count: session_shares_user
    // (migration 230, WHERE revokedAt IS NULL) left SCAN session_shares in this plan
    // until migration 318 added idx_session_shares_userId.
    const rows = await getDbClient().query<ExplainRow>(
      "EXPLAIN QUERY PLAN DELETE FROM users WHERE id = ?",
      ["source"],
    );
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
});

describe("migration 318 created_by backfill", () => {
  // Runs written before PR #1191 (2026-08-19) carry context.swarm.requestedByUserId
  // with created_by NULL. deleteUser narrows its JSON pass by created_by, so the
  // migration has to make the invariant true for those rows first.
  const BACKFILL_DB_PATH = `./test-user-delete-backfill-${crypto.randomUUID()}.sqlite`;
  const MIGRATION_318 = "318_user_fk_indexes";

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${BACKFILL_DB_PATH}${suffix}`);
      } catch {
        // ignore
      }
    }
  });

  test("fills created_by from the context requester only where a known user is named", () => {
    const database = new Database(BACKFILL_DB_PATH);
    try {
      // Apply everything except 318, so legacy rows can be written first.
      const sql = readFileSync(`src/be/migrations/${MIGRATION_318}.sql`, "utf-8");
      database.run(
        `CREATE TABLE IF NOT EXISTS _migrations (
           version INTEGER PRIMARY KEY, name TEXT NOT NULL,
           applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`,
      );
      database
        .prepare(
          "INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
        )
        .run(
          318,
          MIGRATION_318,
          new Date().toISOString(),
          new Bun.CryptoHasher("sha256").update(sql).digest("hex"),
        );
      runMigrations(database);

      const requester = crypto.randomUUID();
      const other = crypto.randomUUID();
      const workflowId = crypto.randomUUID();
      database
        .prepare("INSERT INTO users (id, name) VALUES (?, ?), (?, ?)")
        .run(requester, "legacy requester", other, "other user");
      database
        .prepare("INSERT INTO workflows (id, name, definition) VALUES (?, ?, ?)")
        .run(workflowId, "legacy workflow", '{"nodes":[]}');
      const insertRun = database.prepare(
        "INSERT INTO workflow_runs (id, workflowId, created_by, context) VALUES (?, ?, ?, ?)",
      );
      const legacy = crypto.randomUUID();
      const ghost = crypto.randomUUID();
      const noRequester = crypto.randomUUID();
      const attributed = crypto.randomUUID();
      insertRun.run(
        legacy,
        workflowId,
        null,
        JSON.stringify({ swarm: { requestedByUserId: requester } }),
      );
      insertRun.run(
        ghost,
        workflowId,
        null,
        JSON.stringify({ swarm: { requestedByUserId: "deleted-user" } }),
      );
      insertRun.run(
        noRequester,
        workflowId,
        null,
        JSON.stringify({ trigger: { kind: "schedule" } }),
      );
      insertRun.run(
        attributed,
        workflowId,
        other,
        JSON.stringify({ swarm: { requestedByUserId: requester } }),
      );

      database.run("DELETE FROM _migrations WHERE version = 318");
      runMigrations(database);

      const createdBy = (id: string) =>
        database
          .query<{ created_by: string | null }, [string]>(
            "SELECT created_by FROM workflow_runs WHERE id = ?",
          )
          .get(id)?.created_by;
      expect(createdBy(legacy)).toBe(requester);
      expect(createdBy(ghost)).toBeNull();
      expect(createdBy(noRequester)).toBeNull();
      expect(createdBy(attributed)).toBe(other);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        database
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_shares_userId'",
          )
          .get()?.name,
      ).toBe("idx_session_shares_userId");
    } finally {
      database.close();
    }
  });
});
