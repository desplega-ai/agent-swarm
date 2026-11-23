import { sql, sqlList } from "../db";
// statusKind tells apart why a task ended (failed + agent vs failed + error) while every
// `status` read keeps matching: a `status = 'failed'` filter still returns both kinds.
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  cancelQuietly,
  claimTask,
  createAssignedTask,
  expectToolOk,
  listOf,
  readTask,
  registerLead,
  registerWorker,
  retireAgent,
} from "./core-helpers";
import { expectRunOk, runScript } from "./script-helpers";

const SCRIPT_CANCEL = `export default async function (args: { taskId: string }, ctx: any) {
  return await ctx.swarm.task_cancel({ taskId: args.taskId });
}`;

async function expectKind(
  ctx: ScenarioContext,
  taskId: string,
  status: string,
  statusKind: string,
): Promise<void> {
  const task = await readTask(ctx, taskId);
  expect(
    task.status === status && task.statusKind === statusKind,
    `Task ${taskId} should be ${status}/${statusKind}, got ${String(task.status)}/${String(task.statusKind)}`,
  );
}

async function listIds(ctx: ScenarioContext, query: string): Promise<string[]> {
  const response = await ctx.api("GET", `/api/tasks?${query}`);
  expectStatus(response, [200], `list tasks ${query}`);
  return listOf(response.json, "tasks").map((task) => String(task.id));
}

export const coreTaskStatusKind: Scenario = {
  name: "core-task-status-kind",
  order: 228,
  async run(ctx) {
    const agentId = await registerWorker(ctx, "status-kind");
    const leadId = await registerLead(ctx, "status-kind");
    const conn = await ctx.connectMcp(agentId);
    const cleanup: string[] = [];
    const start = async (label: string, extra: Record<string, unknown> = {}) => {
      const id = await createAssignedTask(ctx, agentId, `status kind ${label} ${ctx.nonce}`, extra);
      cleanup.push(id);
      return id;
    };
    try {
      // The agent chose to fail: store-progress.
      const agentFailed = await start("agent-failed");
      await claimTask(ctx, agentId, agentFailed);
      await expectToolOk(conn, "store-progress", {
        taskId: agentFailed,
        status: "failed",
        failureReason: `gave up ${ctx.nonce}`,
      });
      await expectKind(ctx, agentFailed, "failed", "agent");

      // The runner reported a failure (crash, exit code): /finish. Its dependent cascades.
      const errored = await start("runner-failed");
      const dependent = await start("dependent", { dependsOn: [errored] });
      await claimTask(ctx, agentId, errored);
      const finish = await ctx.api("POST", `/api/tasks/${errored}/finish`, {
        agentId,
        body: { status: "failed", failureReason: "exit 143" },
      });
      expectStatus(finish, [200], "runner fails the task");
      await expectKind(ctx, errored, "failed", "error");
      await expectKind(ctx, dependent, "failed", "cascade");

      // Completions: the agent's store-progress and the runner wrapper.
      const agentDone = await start("agent-completed");
      await claimTask(ctx, agentId, agentDone);
      await expectToolOk(conn, "store-progress", {
        taskId: agentDone,
        status: "completed",
        output: `done ${ctx.nonce}`,
      });
      await expectKind(ctx, agentDone, "completed", "agent");
      const runnerDone = await start("runner-completed");
      await claimTask(ctx, agentId, runnerDone);
      expectStatus(
        await ctx.api("POST", `/api/tasks/${runnerDone}/finish`, {
          agentId,
          body: { status: "completed", output: `wrapped ${ctx.nonce}` },
        }),
        [200],
        "runner completes the task",
      );
      await expectKind(ctx, runnerDone, "completed", "runner");

      // A supersede stores its resume reason as the kind.
      const superseded = await start("superseded");
      await claimTask(ctx, agentId, superseded);
      const cut = await ctx.api("POST", `/api/tasks/${superseded}/supersede`, {
        agentId,
        body: { reason: "graceful_shutdown" },
      });
      expectStatus(cut, [200], "supersede the running task");
      const resumeId = asRecord(cut.json).resumeTaskId;
      if (typeof resumeId === "string") cleanup.push(resumeId);
      await expectKind(ctx, superseded, "superseded", "graceful_shutdown");

      // A person cancelled it from the dashboard API. A body kind cannot override
      // the server's attribution.
      const userCancelled = await start("user-cancelled");
      expectStatus(
        await ctx.api("POST", `/api/tasks/${userCancelled}/cancel`, {
          body: { reason: "nope", statusKind: "agent" },
        }),
        [200],
        "cancel from the API",
      );
      await expectKind(ctx, userCancelled, "cancelled", "user");

      // An agent cancelled it over REST (X-Agent-ID), even with a spoofed body kind.
      const agentRestCancelled = await start("agent-rest-cancelled");
      expectStatus(
        await ctx.api("POST", `/api/tasks/${agentRestCancelled}/cancel`, {
          agentId: leadId,
          body: { reason: "agent chose to cancel", statusKind: "external" },
        }),
        [200],
        "lead cancels over REST",
      );
      await expectKind(ctx, agentRestCancelled, "cancelled", "agent");

      // An agent's script cancelled it: ctx.swarm.task_cancel routes to the same REST path.
      const scriptCancelled = await start("agent-script-cancelled");
      expectRunOk(
        await runScript(ctx, leadId, {
          source: SCRIPT_CANCEL,
          args: { taskId: scriptCancelled },
          intent: `e2e status kind cancel ${ctx.nonce}`,
        }),
        "lead cancels from a script",
      );
      await expectKind(ctx, scriptCancelled, "cancelled", "agent");

      // Back-compat: the status filter, in SQL and over HTTP, still matches every kind.
      const failedIds = [agentFailed, errored, dependent];
      const sqlRows = ctx.db.query<{ id: string }>(
        sql`SELECT id FROM agent_tasks WHERE status = 'failed' AND id IN (${sqlList(failedIds)})`,
      );
      expect(sqlRows.length === 3, `status = 'failed' matched ${sqlRows.length} of 3 rows`);
      const byStatus = await listIds(ctx, `status=failed&agentId=${agentId}`);
      expect(
        failedIds.every((id) => byStatus.includes(id)),
        `status=failed missed a kind: ${byStatus.join(",")}`,
      );
      const byKind = await listIds(ctx, `status=failed&statusKind=error&agentId=${agentId}`);
      expect(
        byKind.length === 1 && byKind[0] === errored,
        `statusKind=error returned ${byKind.join(",")}`,
      );
      const slim = await ctx.api("GET", `/api/tasks?status=failed&agentId=${agentId}`);
      const slimRow = listOf(slim.json, "tasks").find((task) => task.id === agentFailed);
      expect(slimRow?.statusKind === "agent", "Slim list rows do not carry statusKind");
      expectStatus(
        await ctx.api("GET", "/api/tasks?statusKind=not-a-kind"),
        [400],
        "unknown statusKind",
      );

      // MCP: get-tasks filters by kind; get-task-details names it.
      const viaTool = await expectToolOk(conn, "get-tasks", {
        status: "failed",
        statusKind: "cascade",
        mineOnly: true,
      });
      const toolRows = listOf(viaTool.data, "tasks");
      expect(
        toolRows.length === 1 &&
          toolRows[0]?.id === dependent &&
          toolRows[0]?.statusKind === "cascade",
        `get-tasks statusKind=cascade returned ${JSON.stringify(toolRows)}`,
      );
      const details = await expectToolOk(conn, "get-task-details", { taskId: errored });
      expect(
        asRecord(details.data.task).statusKind === "error",
        "get-task-details does not expose statusKind",
      );
    } finally {
      await conn.close();
      for (const id of cleanup) await cancelQuietly(ctx, id);
      await retireAgent(ctx, leadId);
    }
  },
};
