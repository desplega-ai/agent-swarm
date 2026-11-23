import { sql, sqlList } from "../db";
import { type ApiResponse, asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { withMcp } from "./core-helpers";

const WORKERS = 24;
const TASKS = 60;
const MAX_ROUNDS = 40;

// Many workers poll and finish at once until a larger pool drains. Every call must
// answer below 500, every task goes to exactly one worker, and a worker with
// maxTasks 1 never holds two tasks.
//
// The pool tasks come from send-task without an agentId (an agent caller), which
// keeps them in the pool even after a lead registered (POST /api/tasks would hand
// them to the lead). requiredCapabilities keeps them away from other agents.
export const stressPollClaim: Scenario = {
  name: "stress-poll-claim",
  order: 9_443,
  async run(ctx) {
    const capability = `stress-claim-${ctx.nonce}`;
    let calls = 0;
    const serverErrors: string[] = [];
    const track = async (label: string, send: Promise<ApiResponse>) => {
      const response = await send;
      calls++;
      if (response.status >= 500) serverErrors.push(`${label}: ${response.status}`);
      return response;
    };

    const register = async (name: string) => {
      const response = await track(
        "register",
        ctx.api("POST", "/api/agents", {
          body: { name, role: "worker", status: "online", maxTasks: 1 },
        }),
      );
      expectStatus(response, [201], `register ${name}`);
      return asString(asRecord(response.json).id, `${name} id`);
    };
    const creatorId = await register(`e2e-stress-creator-${ctx.nonce}`);
    // Registration does not store capabilities; the profile update does.
    const workers = await Promise.all(
      Array.from({ length: WORKERS }, async (_, i) => {
        const agentId = await register(`e2e-stress-${i}-${ctx.nonce}`);
        const profile = await track(
          "profile",
          ctx.api("PUT", `/api/agents/${agentId}/profile`, {
            body: { capabilities: [capability] },
          }),
        );
        expectStatus(profile, [200], "give the worker the stress capability");
        return agentId;
      }),
    );

    const taskIds = new Set<string>();
    await withMcp(ctx, creatorId, async (conn) => {
      for (let i = 0; i < TASKS; i++) {
        const result = asRecord(
          await conn.callTool("send-task", {
            task: `Stress pool task ${i} ${ctx.nonce}`,
            requiredCapabilities: [capability],
            priority: 90,
          }),
        );
        const data = asRecord(result.structuredContent);
        expect(result.isError !== true, `send-task ${i} failed: ${JSON.stringify(data)}`);
        const task = asRecord(data.task);
        taskIds.add(asString(task.id ?? data.taskId, `send-task ${i} task id`));
      }
    });
    expect(taskIds.size === TASKS, `created ${taskIds.size} distinct pool tasks`);
    // The heartbeat may hand pool tasks to idle workers before they poll (a second
    // claimer racing the polls); such a task reaches its worker through the same poll.
    const pooled = ctx.db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM agent_tasks WHERE id IN (${sqlList([...taskIds])}) AND status = 'unassigned'`,
    );

    const winners = new Map<string, string[]>();
    const held = new Map<string, string>();
    const foreign: string[] = [];
    const doubleHolds: string[] = [];
    let finished = 0;

    const finish = async (agentId: string, taskId: string) => {
      const response = await track(
        "finish",
        ctx.api("POST", `/api/tasks/${taskId}/finish`, {
          agentId,
          body: { status: "completed", output: `stress done ${taskId}` },
        }),
      );
      expectStatus(response, [200], `finish ${taskId}`);
      held.delete(agentId);
      if (taskIds.has(taskId)) finished++;
    };

    const poll = async (agentId: string) => {
      const response = await track("poll", ctx.api("GET", "/api/poll", { agentId }));
      expectStatus(response, [200], "stress poll");
      const trigger = asRecord(response.json).trigger;
      if (!trigger) return;
      const record = asRecord(trigger);
      if (record.type !== "task_assigned" || typeof record.taskId !== "string") return;
      const taskId = record.taskId;
      const holding = held.get(agentId);
      if (holding === taskId) return;
      if (holding) doubleHolds.push(`${agentId} got ${taskId} while holding ${holding}`);
      held.set(agentId, taskId);
      if (taskIds.has(taskId)) winners.set(taskId, [...(winners.get(taskId) ?? []), agentId]);
      else foreign.push(taskId);
    };

    const started = performance.now();
    let rounds = 0;
    while (finished < TASKS && rounds < MAX_ROUNDS) {
      rounds++;
      // A holder polls (it must not get a second task), then finishes; a free worker
      // polls for a claim. All of it in the same tick.
      await Promise.all(
        workers.map(async (agentId) => {
          const holding = held.get(agentId);
          await poll(agentId);
          if (holding) await finish(agentId, holding);
        }),
      );
    }
    // A task claimed in the last round is still held: finish it.
    await Promise.all([...held].map(([agentId, taskId]) => finish(agentId, taskId)));
    const wallMs = Math.round(performance.now() - started);
    ctx.log(
      `stress: ${WORKERS} workers, ${TASKS} tasks, ${rounds} rounds, ${calls} calls, ` +
        `${wallMs} ms wall, ${Number(pooled?.n)} still pooled at start, ${foreign.length} foreign tasks drained`,
    );

    expect(serverErrors.length === 0, `5xx responses: ${serverErrors.slice(0, 10).join("; ")}`);
    expect(doubleHolds.length === 0, `a worker held two tasks: ${doubleHolds.slice(0, 5)}`);
    for (const taskId of taskIds) {
      const won = winners.get(taskId) ?? [];
      expect(won.length === 1, `task ${taskId} was claimed ${won.length} times: ${won}`);
    }
    const rows = ctx.db.query<{ id: string; status: string; agentId: string | null }>(
      sql`SELECT id, status, "agentId" FROM agent_tasks WHERE id IN (${sqlList([...taskIds])})`,
    );
    expect(rows.length === TASKS, `found ${rows.length} of ${TASKS} task rows`);
    for (const row of rows) {
      expect(
        row.status === "completed" && row.agentId === winners.get(row.id)?.[0],
        `task ${row.id} ended ${row.status}/${row.agentId}, poll winner ${winners.get(row.id)?.[0]}`,
      );
    }
  },
};
