import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RetentionRepository, RetentionSweep, Storage } from "../../src";
import { sql, sqlIdent } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-01T00:00:00.000Z";
const OLD = "2026-10-01 00:00:00";
const CUTOFF = "2026-11-05 12:00:00";

const AGENT_LOG: RetentionSweep = {
  policy: "age",
  table: "agent_log",
  timeColumn: "createdAt",
  cutoff: "2026-11-05T00:00:00.000Z",
};

const SCRIPT_RUNS: RetentionSweep = {
  policy: "age",
  table: "script_runs",
  timeColumn: "startedAt",
  cutoff: CUTOFF,
  statusColumn: "status",
  terminalStatuses: ["completed", "failed"],
  keepWhenSet: "idempotencyKey",
};

const CONTEXT_VERSIONS: RetentionSweep = {
  policy: "keepLatest",
  table: "context_versions",
  partitionBy: "agentId, field",
  rankBy: "version",
  keep: 2,
};

const WORKFLOW_RUNS: RetentionSweep = {
  policy: "workflowRuns",
  table: "workflow_runs",
  cutoff: CUTOFF,
  maxDepth: 32,
};

export function retentionContract(engine: ContractEngine): void {
  describe(`retention repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: RetentionRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.retention;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const ids = async (table: string) =>
      (
        await storage.executor.query<{ id: string }>(
          sql`SELECT id FROM ${sqlIdent(table)} ORDER BY id`,
        )
      ).map((row) => row.id);

    const log = (id: string, createdAt: string) =>
      storage.executor.run(
        sql`INSERT INTO agent_log (id, "eventType", "createdAt") VALUES (${id}, 'test', ${createdAt})`,
      );

    const scriptRun = (id: string, status: string, startedAt: string, key: string | null = null) =>
      storage.executor.run(sql`
        INSERT INTO script_runs (id, "agentId", source, status, "startedAt", "idempotencyKey")
        VALUES (${id}, 'agent-a', 'x', ${status}, ${startedAt}, ${key})`);

    const version = (id: string, agentId: string, field: string, v: number) =>
      storage.executor.run(sql`
        INSERT INTO context_versions (id, "agentId", field, content, version, "changeSource", "contentHash", "createdAt")
        VALUES (${id}, ${agentId}, ${field}, 'c', ${v}, 'self_edit', 'h', ${T0})`);

    const workflow = () =>
      storage.executor.run(sql`
        INSERT INTO workflows (id, name, definition, "createdAt", "lastUpdatedAt")
        VALUES ('wf', 'wf', '{"nodes":[]}', ${T0}, ${T0})`);

    const run = (
      id: string,
      status: string,
      finishedAt: string | null,
      o: { parentStepId?: string; hash?: string } = {},
    ) =>
      storage.executor.run(sql`
        INSERT INTO workflow_runs (id, "workflowId", status, "finishedAt", "parentStepId", "definitionHash")
        VALUES (${id}, 'wf', ${status}, ${finishedAt}, ${o.parentStepId ?? null}, ${o.hash ?? null})`);

    const step = (id: string, runId: string) =>
      storage.executor.run(sql`
        INSERT INTO workflow_run_steps (id, "runId", "nodeId", "nodeType", status)
        VALUES (${id}, ${runId}, 'n', 'script', 'completed')`);

    test("age: counts and deletes only rows older than the cutoff, oldest first", async () => {
      await log("l1", "2026-10-03T00:00:00.000Z");
      await log("l2", "2026-10-01T00:00:00.000Z");
      await log("l3", "2026-10-02T00:00:00.000Z");
      await log("new", "2026-11-06T00:00:00.000Z");
      expect(await repo.countBacklog(AGENT_LOG)).toBe(3);
      const first = await repo.deleteBatch(AGENT_LOG, 2);
      expect(first.changes).toBe(2);
      expect(first.executionMs).toBeGreaterThanOrEqual(0);
      expect(await ids("agent_log")).toEqual(["l1", "new"]);
      expect((await repo.deleteBatch(AGENT_LOG, 2)).changes).toBe(1);
      expect(await repo.countBacklog(AGENT_LOG)).toBe(0);
      expect((await repo.deleteBatch(AGENT_LOG, 2)).changes).toBe(0);
    });

    test("age: status filter and keepWhenSet keep live and keyed rows", async () => {
      await scriptRun("done", "completed", OLD);
      await scriptRun("failed", "failed", OLD);
      await scriptRun("running", "running", OLD);
      await scriptRun("keyed", "completed", OLD, "k1");
      await scriptRun("recent", "completed", "2026-11-06 00:00:00");
      expect(await repo.countBacklog(SCRIPT_RUNS)).toBe(2);
      expect((await repo.deleteBatch(SCRIPT_RUNS, 10)).changes).toBe(2);
      expect(await ids("script_runs")).toEqual(["keyed", "recent", "running"]);
    });

    test("keepLatest: keeps the newest N per partition and deletes the deepest history first", async () => {
      for (const id of ["a", "c"]) {
        await storage.executor.run(sql`
          INSERT INTO agents (id, name, status, "createdAt", "lastUpdatedAt")
          VALUES (${id}, ${id}, 'offline', ${T0}, ${T0})`);
      }
      for (const v of [1, 2, 3, 4]) await version(`a-${v}`, "a", "soul", v);
      for (const v of [1, 2]) await version(`b-${v}`, "a", "identity", v);
      await version("c-1", "c", "soul", 1);
      expect(await repo.countBacklog(CONTEXT_VERSIONS)).toBe(2);
      expect((await repo.deleteBatch(CONTEXT_VERSIONS, 1)).changes).toBe(1);
      expect(await ids("context_versions")).toEqual(["a-2", "a-3", "a-4", "b-1", "b-2", "c-1"]);
      expect((await repo.deleteBatch(CONTEXT_VERSIONS, 10)).changes).toBe(1);
      expect(await ids("context_versions")).toEqual(["a-3", "a-4", "b-1", "b-2", "c-1"]);
    });

    test("workflowRuns: deleteBatch refuses; the backlog counts eligible terminal roots", async () => {
      await workflow();
      await run("old", "completed", OLD);
      await run("live", "running", null);
      await run("recent", "completed", "2026-11-06 00:00:00");
      expect(await repo.countBacklog(WORKFLOW_RUNS)).toBe(1);
      await expect(repo.deleteBatch(WORKFLOW_RUNS, 10)).rejects.toThrow();
    });

    test("candidates come ordered by finishedAt, then id, and a live child protects its tree", async () => {
      await workflow();
      await storage.executor.run(
        sql`INSERT INTO workflow_run_definitions VALUES ('h1', '{}', ${T0})`,
      );
      await run("b", "completed", OLD, { hash: "h1" });
      await run("a", "failed", OLD);
      await run("c", "cancelled", "2026-09-01 00:00:00");
      await run("parent", "completed", OLD);
      await step("parent-step", "parent");
      await run("child", "running", null, { parentStepId: "parent-step" });
      expect(await repo.listWorkflowRunCandidates(CUTOFF, 10, 32)).toEqual([
        { id: "c", definitionHash: null },
        { id: "a", definitionHash: null },
        { id: "b", definitionHash: "h1" },
      ]);
      expect(await repo.listWorkflowRunCandidates(CUTOFF, 2, 32)).toHaveLength(2);
    });

    test("deleteWorkflowRuns unlinks tasks, removes waits, steps and runs, and returns the task ids", async () => {
      await workflow();
      await run("r1", "completed", OLD);
      await run("r2", "completed", OLD);
      await step("s1", "r1");
      await storage.executor.run(sql`
        INSERT INTO agent_tasks (id, task, status, "createdAt", "lastUpdatedAt", "workflowRunId", "workflowRunStepId")
        VALUES ('t-run', 't', 'completed', ${T0}, ${T0}, 'r1', NULL),
               ('t-step', 't', 'completed', ${T0}, ${T0}, NULL, 's1'),
               ('t-both', 't', 'completed', ${T0}, ${T0}, 'r1', 's1'),
               ('t-other', 't', 'completed', ${T0}, ${T0}, 'r2', NULL)`);
      await storage.executor.run(sql`
        INSERT INTO wait_states (id, "workflowRunId", "workflowRunStepId", mode)
        VALUES ('w1', 'r1', 's1', 'time')`);
      const taskIds = await storage.transaction(() => repo.deleteWorkflowRuns(["r1"]));
      expect([...taskIds].sort()).toEqual(["t-both", "t-run", "t-step"]);
      expect(await ids("workflow_runs")).toEqual(["r2"]);
      expect(await ids("workflow_run_steps")).toEqual([]);
      expect(await ids("wait_states")).toEqual([]);
      const tasks = await storage.executor.query<{
        id: string;
        workflowRunId: string | null;
        workflowRunStepId: string | null;
      }>(sql`SELECT id, "workflowRunId", "workflowRunStepId" FROM agent_tasks ORDER BY id`);
      expect(tasks).toEqual([
        { id: "t-both", workflowRunId: null, workflowRunStepId: null },
        { id: "t-other", workflowRunId: "r2", workflowRunStepId: null },
        { id: "t-run", workflowRunId: null, workflowRunStepId: null },
        { id: "t-step", workflowRunId: null, workflowRunStepId: null },
      ]);
    });

    test("incrementalVacuum runs on any database and rejects a bad page count", async () => {
      await repo.incrementalVacuum(2000);
      await expect(repo.incrementalVacuum(-1)).rejects.toThrow();
    });
  });
}
