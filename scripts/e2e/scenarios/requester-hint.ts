// A body `requestedByUserId` follows the POST /api/tasks rule on every write path that takes
// it: the operator and lead agents may name a user, a non-lead agent may not. Covers steering
// (POST /api/tasks/{id}/steer), script runs (POST /api/script-runs) and script step tasks
// (POST /api/internal/script-runs/{runId}/agent-task).
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  cancelQuietly,
  createUser,
  registerLead,
  registerWorker,
  retireAgent,
} from "./core-helpers";

const NOOP = "export default async function () { return 1; }";

function steerUser(ctx: ScenarioContext, steeringMessageId: unknown) {
  const row = ctx.db.get<{ created_by_kind: string; created_by_user_id: string | null }>(
    "SELECT created_by_kind, created_by_user_id FROM task_steering_messages WHERE id = ?",
    [String(steeringMessageId)],
  );
  expect(row !== null, `No steering row ${String(steeringMessageId)}`);
  return row;
}

function runUser(ctx: ScenarioContext, runId: string) {
  const row = ctx.db.get<{ requestedByUserId: string | null; created_by: string | null }>(
    "SELECT requestedByUserId, created_by FROM script_runs WHERE id = ?",
    [runId],
  );
  expect(row !== null, `No script run row ${runId}`);
  return row;
}

function taskUser(ctx: ScenarioContext, taskId: string): string | null {
  const row = ctx.db.get<{ requestedByUserId: string | null }>(
    "SELECT requestedByUserId FROM agent_tasks WHERE id = ?",
    [taskId],
  );
  expect(row !== null, `No task row ${taskId}`);
  return row.requestedByUserId;
}

export const requesterHint: Scenario = {
  name: "requester-hint",
  order: 346,
  async run(ctx) {
    const lead = await registerLead(ctx, "requester-hint");
    const worker = await registerWorker(ctx, "requester-hint");
    const target = await registerWorker(ctx, "requester-hint-target");
    const user = await createUser(ctx, "requester-hint");
    const stepper = await ctx.startAgent({
      name: `e2e-requester-hint-stepper-${ctx.nonce}`,
      onTask: () => ({ status: "completed", output: "done" }),
    });
    const taskIds: string[] = [];
    try {
      // ── Steering: the worker steers a task it created ──
      const created = await ctx.api("POST", "/api/tasks", {
        agentId: worker,
        body: {
          task: `requester hint steer ${ctx.nonce}`,
          agentId: target,
          routingReason: "human_pinned",
          source: "api",
        },
      });
      expectStatus(created, [201], "worker creates a task");
      const taskId = asString(asRecord(created.json).id, "task id");
      taskIds.push(taskId);

      const workerSteer = await ctx.api("POST", `/api/tasks/${taskId}/steer`, {
        agentId: worker,
        body: { message: `worker steer ${ctx.nonce}`, requestedByUserId: user },
      });
      expectStatus(workerSteer, [200], "worker steers its own task");
      const workerRow = steerUser(ctx, asRecord(workerSteer.json).steeringMessageId);
      expect(
        workerRow.created_by_user_id === null && workerRow.created_by_kind !== "user",
        `A worker steer kept the named user: ${JSON.stringify(workerRow)}`,
      );

      const operatorSteer = await ctx.api("POST", `/api/tasks/${taskId}/steer`, {
        body: { message: `operator steer ${ctx.nonce}`, requestedByUserId: user },
      });
      expectStatus(operatorSteer, [200], "operator steers the task");
      expect(
        steerUser(ctx, asRecord(operatorSteer.json).steeringMessageId).created_by_user_id === user,
        "An operator steer lost the named user",
      );

      // ── Script runs ──
      const launch = async (agentId: string, label: string) => {
        const response = await ctx.api("POST", "/api/script-runs", {
          agentId,
          body: { source: NOOP, background: false, requestedByUserId: user },
        });
        expectStatus(response, [201], label);
        return asString(asRecord(response.json).id, `${label} id`);
      };
      const workerRun = await launch(worker, "worker launches a run naming a user");
      const workerRunRow = runUser(ctx, workerRun);
      expect(
        workerRunRow.requestedByUserId === null && workerRunRow.created_by === null,
        `A worker run kept the named user: ${JSON.stringify(workerRunRow)}`,
      );
      const leadRun = await launch(lead, "lead launches a run naming a user");
      const leadRunRow = runUser(ctx, leadRun);
      expect(
        leadRunRow.requestedByUserId === user && leadRunRow.created_by === user,
        `A lead run lost the named user: ${JSON.stringify(leadRunRow)}`,
      );

      // ── Script step tasks: a non-lead step falls back to the run's requester ──
      const step = async (runId: string, agentId: string, label: string) => {
        const response = await ctx.api("POST", `/api/internal/script-runs/${runId}/agent-task`, {
          agentId,
          body: {
            stepKey: "s",
            task: `requester hint step ${ctx.nonce}`,
            agentId: stepper.agentId,
            requestedByUserId: user,
          },
        });
        expectStatus(response, [200], label);
        const stepTask = asString(asRecord(response.json).taskId, `${label} task id`);
        taskIds.push(stepTask);
        return stepTask;
      };
      const workerStep = await step(workerRun, worker, "worker step names a user");
      expect(taskUser(ctx, workerStep) === null, "A worker step task kept the named user");
      const leadStep = await step(leadRun, lead, "lead step names a user");
      expect(taskUser(ctx, leadStep) === user, "A lead step task lost the named user");
    } finally {
      for (const id of taskIds) await cancelQuietly(ctx, id);
      await stepper.stop();
      for (const id of [worker, target, lead]) await retireAgent(ctx, id);
    }
  },
};
