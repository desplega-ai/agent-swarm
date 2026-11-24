import { sql, sqlList } from "../db";
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { createAssignedTask, registerWorker } from "./core-helpers";

const WORKERS = 12;
const ROOTS_PER_WORKER = 3;
const CHILDREN_PER_WORKER = 2;

// Many unkeyed task creates at once (POST /api/tasks with no idempotency key): every
// worker gets new tasks, half of them children of one parent with its own key, all in
// one tick. Every create answers 201 with a distinct task, each child carries the
// parent's key and parent id, and each create is logged once. The Linear tracker race
// is its own scenario (divergence-tracker-dedup), so this site's bench retry rate
// counts only unkeyed creates with no dedup.
export const stressTaskCreate: Scenario = {
  name: "stress-task-create",
  order: 9_442,
  async run(ctx) {
    const serverErrors: string[] = [];
    const workers = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        registerWorker(ctx, `stress-create-${i}`, { maxTasks: 1 }),
      ),
    );
    const parentKey = `shared/stress-create-${ctx.nonce}/`;
    const parentId = await createAssignedTask(
      ctx,
      workers[0] as string,
      `stress create parent ${ctx.nonce}`,
      { key: parentKey },
    );

    const create = async (label: string, body: Record<string, unknown>) => {
      const response = await ctx.api("POST", "/api/tasks", {
        body: { task: `stress create ${label} ${ctx.nonce}`, source: "api", ...body },
      });
      if (response.status >= 500) serverErrors.push(`create ${label}: ${response.status}`);
      return { label, response };
    };

    // The race: roots and children for every worker, all in one tick.
    const started = performance.now();
    const created = await Promise.all(
      workers.flatMap((agentId, w) => [
        ...Array.from({ length: ROOTS_PER_WORKER }, (_, r) =>
          create(`root ${w}.${r}`, { agentId, routingReason: "human_pinned" }),
        ),
        ...Array.from({ length: CHILDREN_PER_WORKER }, (_, c) =>
          create(`child ${w}.${c}`, {
            agentId,
            routingReason: "human_pinned",
            parentTaskId: parentId,
          }),
        ),
      ]),
    );
    ctx.log(
      `stress create: ${WORKERS} workers, ${created.length} creates, ` +
        `${Math.round(performance.now() - started)} ms wall`,
    );

    expect(serverErrors.length === 0, `5xx responses: ${serverErrors.slice(0, 10).join("; ")}`);
    const ids = new Map<string, string>();
    for (const { label, response } of created) {
      expectStatus(response, [201], `create ${label}`);
      const id = asRecord(response.json).id;
      expect(typeof id === "string", `create ${label}: no task id`);
      ids.set(label, id as string);
    }
    const allIds = [...ids.values()];
    expect(
      new Set(allIds).size === allIds.length,
      `${allIds.length} creates returned ${new Set(allIds).size} distinct tasks`,
    );

    const rows = ctx.db.query<{
      id: string;
      key: string;
      agentId: string | null;
      parentTaskId: string | null;
      status: string;
    }>(
      sql`SELECT id, key, "agentId", "parentTaskId", status FROM agent_tasks WHERE id IN (${sqlList(allIds)})`,
    );
    expect(rows.length === allIds.length, `found ${rows.length} of ${allIds.length} task rows`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    workers.forEach((agentId, w) => {
      for (let c = 0; c < CHILDREN_PER_WORKER; c++) {
        const row = byId.get(ids.get(`child ${w}.${c}`) as string);
        expect(
          row?.parentTaskId === parentId && row.key === parentKey && row.agentId === agentId,
          `child ${w}.${c} stored parent ${row?.parentTaskId}, key ${row?.key}, agent ${row?.agentId}; ` +
            `want ${parentId}, ${parentKey}, ${agentId}`,
        );
      }
      for (let r = 0; r < ROOTS_PER_WORKER; r++) {
        const row = byId.get(ids.get(`root ${w}.${r}`) as string);
        expect(
          row?.parentTaskId === null && row.agentId === agentId && row.status === "pending",
          `root ${w}.${r} stored parent ${row?.parentTaskId}, agent ${row?.agentId}, status ${row?.status}`,
        );
      }
    });

    const logs = ctx.db.query<{ taskId: string; n: number }>(
      sql`SELECT "taskId", COUNT(*) AS n FROM agent_log
          WHERE "taskId" IN (${sqlList(allIds)}) AND "eventType" = 'task_created'
          GROUP BY "taskId"`,
    );
    const logCount = new Map(logs.map((l) => [l.taskId, Number(l.n)]));
    for (const id of allIds) {
      expect(logCount.get(id) === 1, `task ${id}: ${logCount.get(id) ?? 0} create logs, want 1`);
    }
  },
};
