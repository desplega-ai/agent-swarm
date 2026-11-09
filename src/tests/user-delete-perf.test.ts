import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
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
