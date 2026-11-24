import { sql, sqlList } from "../db";
import { type ApiResponse, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { createAssignedTask, registerWorker } from "./core-helpers";

const WORKERS = 12;
const TASKS_PER_WORKER = 4;

// Many runners finish at once: every task of every worker, each finished twice in the
// same tick with a different output. Every call answers below 500, exactly one finish
// per task wins (200, the other 409), the stored result is the winner's, the status
// change is logged once, a failed task fails its dependent once, and every worker ends
// idle (the last finish of a worker sees all its other finishes).
export const stressTaskFinish: Scenario = {
  name: "stress-task-finish",
  order: 9_444,
  async run(ctx) {
    const serverErrors: string[] = [];
    const workers = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        registerWorker(ctx, `stress-finish-${i}`, { maxTasks: TASKS_PER_WORKER }),
      ),
    );

    // Each worker gets TASKS_PER_WORKER tasks; its first one also has a dependent.
    const owned = new Map<string, string[]>();
    const dependents = new Map<string, string>();
    await Promise.all(
      workers.map(async (agentId, w) => {
        const ids: string[] = [];
        for (let t = 0; t < TASKS_PER_WORKER; t++) {
          ids.push(await createAssignedTask(ctx, agentId, `stress finish ${w}.${t} ${ctx.nonce}`));
        }
        const first = ids[0] as string;
        dependents.set(
          first,
          await createAssignedTask(ctx, agentId, `stress finish ${w} dependent ${ctx.nonce}`, {
            dependsOn: [first],
          }),
        );
        owned.set(agentId, ids);
      }),
    );
    const allTasks = [...owned.values()].flat();

    // Each worker polls until all its tasks run (the dependent stays blocked).
    await Promise.all(
      workers.map(async (agentId) => {
        const ids = owned.get(agentId) as string[];
        const running = await pollUntil(async () => {
          const response = await ctx.api("GET", "/api/poll", { agentId });
          expectStatus(response, [200], `poll as ${agentId}`);
          const row = ctx.db.get<{ n: number }>(
            sql`SELECT COUNT(*) AS n FROM agent_tasks WHERE id IN (${sqlList(ids)}) AND status = 'in_progress' AND "agentId" = ${agentId}`,
          );
          return Number(row?.n) === ids.length;
        }, 30_000);
        expect(running, `worker ${agentId} did not get all ${ids.length} tasks running`);
      }),
    );

    // The race: two finishes per task, all in one tick. The first task of each worker
    // fails (its dependent must cascade); the others complete.
    const failing = new Set(dependents.keys());
    const results = new Map<string, { label: string; response: ApiResponse }[]>();
    const finish = async (agentId: string, taskId: string, label: string) => {
      const body = failing.has(taskId)
        ? { status: "failed", failureReason: `stress ${label} ${taskId}` }
        : { status: "completed", output: `stress ${label} ${taskId}` };
      const response = await ctx.api("POST", `/api/tasks/${taskId}/finish`, { agentId, body });
      if (response.status >= 500) serverErrors.push(`finish ${taskId}: ${response.status}`);
      results.set(taskId, [...(results.get(taskId) ?? []), { label, response }]);
    };
    const started = performance.now();
    await Promise.all(
      [...owned].flatMap(([agentId, ids]) =>
        ids.flatMap((taskId) => [finish(agentId, taskId, "a"), finish(agentId, taskId, "b")]),
      ),
    );
    ctx.log(
      `stress finish: ${WORKERS} workers, ${allTasks.length} tasks, ${allTasks.length * 2} finishes, ` +
        `${Math.round(performance.now() - started)} ms wall`,
    );

    expect(serverErrors.length === 0, `5xx responses: ${serverErrors.slice(0, 10).join("; ")}`);
    const winners = new Map<string, string>();
    for (const taskId of allTasks) {
      const pair = results.get(taskId) ?? [];
      const won = pair.filter((r) => r.response.status === 200);
      const lost = pair.filter((r) => r.response.status === 409);
      expect(
        won.length === 1 && lost.length === 1,
        `task ${taskId}: finishes answered ${pair.map((r) => r.response.status).join(", ")}, want one 200 and one 409`,
      );
      winners.set(taskId, `stress ${won[0]?.label} ${taskId}`);
    }

    const rows = ctx.db.query<{
      id: string;
      status: string;
      output: string | null;
      failureReason: string | null;
    }>(
      sql`SELECT id, status, output, "failureReason" FROM agent_tasks WHERE id IN (${sqlList(allTasks)})`,
    );
    expect(rows.length === allTasks.length, `found ${rows.length} of ${allTasks.length} task rows`);
    for (const row of rows) {
      const want = failing.has(row.id) ? "failed" : "completed";
      const text = failing.has(row.id) ? row.failureReason : row.output;
      expect(
        row.status === want && text === winners.get(row.id),
        `task ${row.id} ended ${row.status} with "${text}", want ${want} with "${winners.get(row.id)}"`,
      );
    }

    const logs = ctx.db.query<{ taskId: string; n: number }>(
      sql`SELECT "taskId", COUNT(*) AS n FROM agent_log
          WHERE "taskId" IN (${sqlList(allTasks)}) AND "eventType" = 'task_status_change'
            AND "newValue" IN ('completed', 'failed')
          GROUP BY "taskId"`,
    );
    const logCount = new Map(logs.map((l) => [l.taskId, Number(l.n)]));
    for (const taskId of allTasks) {
      expect(
        logCount.get(taskId) === 1,
        `task ${taskId}: ${logCount.get(taskId) ?? 0} terminal status logs, want 1`,
      );
    }

    const cascaded = ctx.db.query<{ id: string; status: string; statusKind: string | null }>(
      sql`SELECT id, status, "statusKind" FROM agent_tasks WHERE id IN (${sqlList([...dependents.values()])})`,
    );
    for (const row of cascaded) {
      expect(
        row.status === "failed" && row.statusKind === "cascade",
        `dependent ${row.id} ended ${row.status}/${row.statusKind}, want failed/cascade`,
      );
    }

    const agents = ctx.db.query<{ id: string; status: string }>(
      sql`SELECT id, status FROM agents WHERE id IN (${sqlList(workers)})`,
    );
    for (const agent of agents) {
      expect(
        agent.status === "idle",
        `worker ${agent.id} ended ${agent.status} with no task running, want idle`,
      );
    }
  },
};
