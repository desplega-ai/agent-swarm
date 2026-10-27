import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createSessionCost,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  getDbClient,
  initDb,
} from "../be/db";
import gather from "../be/seed-scripts/catalog/dreaming-gather";

const TEST_DB_PATH = "./test-dreaming-gather-prev-run.sqlite";

let agentId = "";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // absent
    }
  }
}

// db_query runs the script's SQL against the test DB and answers in the MCP tool's {columns, rows} shape.
const ctx = {
  swarm: {
    db_query: async ({ sql, params }: { sql: string; params?: unknown[] }) => {
      const out = await getDbClient().query<Record<string, unknown>>(
        sql,
        (params ?? []) as never[],
      );
      const columns = out.length ? Object.keys(out[0]!) : [];
      return { columns, rows: out.map((r) => columns.map((c) => r[c])) };
    },
    kv_getOrNull: async () => null,
  },
} as any;

/** A finished run of `workflowId` started `hoursAgo`, with one task that cost `usd`. */
async function pastRun(
  workflowId: string,
  hoursAgo: number,
  triggerType: "schedule" | "manual",
  triggerData: unknown,
  usd: number,
): Promise<string> {
  const id = crypto.randomUUID();
  await createWorkflowRun({ id, workflowId, triggerType, triggerData });
  const startedAt = new Date(Date.now() - hoursAgo * 3600000).toISOString();
  await getDbClient().run(
    `UPDATE workflow_runs SET startedAt = ?, status = 'completed' WHERE id = ?`,
    [startedAt, id],
  );
  const task = await createTaskExtended(`dreaming fixture task for ${id}`, {
    agentId,
    workflowRunId: id,
  });
  await createSessionCost({
    sessionId: `s-${id}`,
    taskId: task.id,
    agentId,
    totalCostUsd: usd,
    durationMs: 1,
    numTurns: 1,
    model: "test-model",
  });
  return id;
}

async function newWorkflow(name: string): Promise<string> {
  return (await createWorkflow({ name, definition: { nodes: [] } })).id;
}

async function currentRun(workflowId: string): Promise<string> {
  const id = crypto.randomUUID();
  await createWorkflowRun({ id, workflowId, triggerType: "manual" });
  return id;
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "gather-prev-run-lead", isLead: true, status: "idle" })).id;
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("dreaming-gather previous night", () => {
  test("a prior manual, non-dry run (the seeded daily trigger) sets prevRunId and prevRunUsd", async () => {
    const wf = await newWorkflow("gather-prev-manual");
    const prev = await pastRun(wf, 24, "manual", {}, 30);
    const out: any = await gather({ runId: await currentRun(wf) }, ctx);
    expect(out.night.number).toBe(2);
    expect(out.night.previousRunId).toBe(prev);
    expect(out.budget.prevRunId).toBe(prev);
    expect(out.budget.prevRunUsd).toBe(30);
    expect(out.budget.overBudget).toBe(true);
  });

  test("a later dry run is skipped, both as boolean and as the string a template renders", async () => {
    const wf = await newWorkflow("gather-prev-dry");
    const real = await pastRun(wf, 30, "manual", {}, 12.5);
    await pastRun(wf, 6, "manual", { dryRun: true }, 3);
    await pastRun(wf, 3, "manual", { dryRun: "true" }, 4);
    const out: any = await gather({ runId: await currentRun(wf) }, ctx);
    expect(out.night.number).toBe(2);
    expect(out.budget.prevRunId).toBe(real);
    expect(out.budget.prevRunUsd).toBe(12.5);
    expect(out.budget.overBudget).toBe(false);
  });

  test("only dry runs before this one leaves no previous night", async () => {
    const wf = await newWorkflow("gather-prev-only-dry");
    await pastRun(wf, 6, "manual", { dryRun: true }, 3);
    const out: any = await gather({ runId: await currentRun(wf) }, ctx);
    expect(out.night.number).toBe(1);
    expect(out.budget.prevRunId).toBeNull();
    expect(out.budget.prevRunUsd).toBeNull();
  });

  test("control: a schedule-started run still counts, and a dryRun: false payload is real", async () => {
    const wf = await newWorkflow("gather-prev-schedule");
    await pastRun(wf, 48, "schedule", null, 9);
    const latest = await pastRun(wf, 24, "manual", { dryRun: false }, 23);
    const out: any = await gather({ runId: await currentRun(wf) }, ctx);
    expect(out.night.number).toBe(3);
    expect(out.budget.prevRunId).toBe(latest);
    expect(out.budget.prevRunUsd).toBe(23);
    expect(out.budget.overBudget).toBe(true);
    expect(
      out.errors.filter((e: string) => e.startsWith("prevRuns") || e.startsWith("prevRunCost")),
    ).toEqual([]);
  });
});
