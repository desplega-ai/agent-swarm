// Cancelling workflow runs: a waiting run, a run with an open agent task, a run parked
// on an approval, a fan-out, and a whole sub-workflow tree. Cancel finishes every piece
// of open work and a late signal or answer cannot revive the run.
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  approvalsForRun,
  callToolErr,
  callToolOk,
  createWorkflow,
  getRunDetail,
  registerWorker,
  stepOf,
  triggerWorkflow,
  type WorkflowNodeDef,
  waitForApproval,
  waitForRun,
  waitForStep,
} from "./workflow-helpers";

function bash(id: string, script: string, next?: WorkflowNodeDef["next"]) {
  return { id, type: "script", config: { runtime: "bash", script }, next };
}

export const workflowEngineCancel: Scenario = {
  name: "workflow-engine-cancel",
  order: 335,
  async run(ctx) {
    const marker = `cancel-${ctx.nonce}`;
    const workerId = await registerWorker(ctx, "wf-cancel");
    // Registered but never polling: tasks pinned to it stay open until the cancel.
    const idleId = await registerWorker(ctx, "wf-idle");
    const connection = await ctx.connectMcp(workerId);

    try {
      // ── a waiting run ───────────────────────────────────────────────────────
      const waitId = await createWorkflow(
        ctx,
        "cancel-wait",
        {
          nodes: [
            {
              id: "w",
              type: "wait",
              config: { mode: "event", eventName: `e2e.cancel.${ctx.nonce}`, scope: "run" },
              next: { event: "after" },
            },
            bash("after", "echo revived"),
          ],
        },
        {},
        workerId,
      );
      const waitRun = await triggerWorkflow(ctx, waitId, {}, { agentId: workerId });
      await waitForStep(ctx, waitRun.runId, "w", "waiting");
      const cancelled = await ctx.api("POST", `/api/workflow-runs/${waitRun.runId}/cancel`, {
        body: { reason: `stop ${marker}` },
      });
      expectStatus(cancelled, [200], "cancel a waiting run");
      expect(asRecord(cancelled.json).success === true, "cancel answers success");
      const afterCancel = await getRunDetail(ctx, waitRun.runId);
      expect(
        afterCancel.run.status === "cancelled" && afterCancel.run.error === `stop ${marker}`,
        `cancelled run: ${JSON.stringify([afterCancel.run.status, afterCancel.run.error])}`,
      );
      expect(
        stepOf(afterCancel, "w").status === "cancelled",
        "the waiting step is cancelled with the run",
      );
      expect(typeof afterCancel.run.finishedAt === "string", "a cancelled run has a finish time");
      // wait_states has no cancelled status: the row stays pending, and the cancelled step
      // makes a late signal a no-op (checked below).

      // A late signal cannot revive a cancelled run.
      expectStatus(
        await ctx.api("POST", `/api/workflow-runs/${waitRun.runId}/events`, {
          body: { name: `e2e.cancel.${ctx.nonce}`, payload: {} },
        }),
        [200],
        "signal a cancelled run",
      );
      const stillCancelled = await getRunDetail(ctx, waitRun.runId);
      expect(
        stillCancelled.run.status === "cancelled" &&
          !stillCancelled.steps.some((step) => step.nodeId === "after"),
        "a late signal does not resume a cancelled run",
      );
      // Repeating the cancel is fine and keeps the first reason.
      const again = await ctx.api("POST", `/api/workflow-runs/${waitRun.runId}/cancel`, {
        body: { reason: "second reason" },
      });
      expectStatus(again, [200], "cancel a cancelled run again");
      expect(
        (await getRunDetail(ctx, waitRun.runId)).run.error === `stop ${marker}`,
        "the first cancel reason is kept",
      );
      const noBody = await ctx.api("POST", `/api/workflow-runs/${waitRun.runId}/cancel`);
      expectStatus(noBody, [200], "cancel with no body");

      // ── an open agent task ──────────────────────────────────────────────────
      const taskId = await createWorkflow(
        ctx,
        "cancel-task",
        {
          nodes: [
            {
              id: "t",
              type: "agent-task",
              config: { agentId: idleId, template: `idle work ${marker}` },
              next: "after",
            },
            bash("after", "echo never"),
          ],
        },
        {},
        workerId,
      );
      const taskRun = await triggerWorkflow(ctx, taskId, {}, { agentId: workerId });
      const taskStep = await waitForStep(ctx, taskRun.runId, "t", "waiting");
      const openTask = ctx.db.get<{ id: string; status: string }>(
        "SELECT id, status FROM agent_tasks WHERE workflowRunStepId = ?",
        [String(taskStep.id)],
      );
      expect(openTask && openTask.status !== "completed", "the pinned task is open");
      const toolCancel = await callToolOk(connection, "cancel-workflow-run", {
        runId: taskRun.runId,
        reason: `tool cancel ${marker}`,
      });
      expect(toolCancel.text.includes(taskRun.runId), "cancel tool names the run");
      const taskCancelled = await getRunDetail(ctx, taskRun.runId);
      expect(
        taskCancelled.run.status === "cancelled" &&
          taskCancelled.run.error === `tool cancel ${marker}`,
        "cancel tool cancels the run with its reason",
      );
      const closedTask = ctx.db.get<{ status: string }>(
        "SELECT status FROM agent_tasks WHERE id = ?",
        [openTask?.id ?? ""],
      );
      expect(
        closedTask?.status === "cancelled",
        `the open task was cancelled: ${closedTask?.status}`,
      );
      await callToolErr(
        connection,
        "cancel-workflow-run",
        { runId: crypto.randomUUID() },
        "not found",
      );

      // ── a run parked on an approval ─────────────────────────────────────────
      const hitlId = await createWorkflow(
        ctx,
        "cancel-hitl",
        {
          nodes: [
            {
              id: "ask",
              type: "human-in-the-loop",
              config: {
                title: `Cancel me ${marker}`,
                questions: [{ id: "go", type: "approval", label: "Go?" }],
                approvers: { policy: "any" },
              },
              next: { approved: "after" },
            },
            bash("after", "echo never"),
          ],
        },
        {},
        workerId,
      );
      const hitlRun = await triggerWorkflow(ctx, hitlId, {}, { agentId: workerId });
      const card = await waitForApproval(ctx, hitlRun.runId);
      expectStatus(
        await ctx.api("POST", `/api/workflow-runs/${hitlRun.runId}/cancel`, {
          body: { reason: "no" },
        }),
        [200],
        "cancel a run with a pending approval",
      );
      const cancelledCards = await approvalsForRun(ctx, hitlRun.runId, "cancelled");
      expect(
        cancelledCards.length === 1 && cancelledCards[0]?.id === card.id,
        "the pending approval is cancelled with the run",
      );
      const lateAnswer = await ctx.api(
        "POST",
        `/api/approval-requests/${String(card.id)}/respond`,
        {
          body: { responses: { go: { approved: true } } },
        },
      );
      expectStatus(lateAnswer, [409], "answer an approval of a cancelled run");
      expect(
        String(asRecord(lateAnswer.json).error).includes("cancelled"),
        "the late answer is refused as cancelled",
      );
      expect(
        (await getRunDetail(ctx, hitlRun.runId)).run.status === "cancelled",
        "a late answer does not revive the run",
      );

      // ── a fan-out of agent tasks ────────────────────────────────────────────
      const fanId = await createWorkflow(
        ctx,
        "cancel-fan",
        {
          nodes: [
            {
              id: "fan",
              type: "foreach",
              inputs: { items: "trigger.items" },
              config: {
                over: "{{items}}",
                itemKey: "id",
                concurrency: 2,
                body: {
                  type: "agent-task",
                  config: { agentId: idleId, template: `fan {{item.id}} ${marker}` },
                },
              },
            },
          ],
        },
        {},
        workerId,
      );
      const fanRun = await triggerWorkflow(
        ctx,
        fanId,
        { items: [{ id: "f1" }, { id: "f2" }, { id: "f3" }] },
        { agentId: workerId },
      );
      await waitForStep(ctx, fanRun.runId, "fan#f1", "waiting");
      await waitForStep(ctx, fanRun.runId, "fan#f2", "waiting");
      expectStatus(
        await ctx.api("POST", `/api/workflow-runs/${fanRun.runId}/cancel`, {
          body: { reason: "stop fan" },
        }),
        [200],
        "cancel a fan-out",
      );
      const fanDetail = await getRunDetail(ctx, fanRun.runId);
      const childStatuses = fanDetail.steps
        .filter((step) => String(step.nodeId).startsWith("fan#"))
        .map((step) => String(step.status));
      expect(
        fanDetail.run.status === "cancelled" &&
          childStatuses.length >= 2 &&
          childStatuses.every((status) => status === "cancelled"),
        `fan-out children are cancelled: ${JSON.stringify(childStatuses)}`,
      );
      const openFanTasks = ctx.db.query<{ status: string }>(
        "SELECT status FROM agent_tasks WHERE workflowRunId = ?",
        [fanRun.runId],
      );
      expect(
        openFanTasks.length >= 2 && openFanTasks.every((task) => task.status === "cancelled"),
        `fan-out tasks are cancelled: ${JSON.stringify(openFanTasks)}`,
      );

      // ── a sub-workflow tree ─────────────────────────────────────────────────
      const childId = await createWorkflow(
        ctx,
        "cancel-child",
        { nodes: [{ id: "cw", type: "wait", config: { mode: "time", durationMs: 600000 } }] },
        {},
        workerId,
      );
      const parentId = await createWorkflow(
        ctx,
        "cancel-parent",
        {
          nodes: [
            {
              id: "sub",
              type: "sub-workflow",
              config: { workflowId: childId, inputs: {} },
              next: "after",
            },
            bash("after", "echo never"),
          ],
        },
        {},
        workerId,
      );
      const parentRun = await triggerWorkflow(ctx, parentId, {}, { agentId: workerId });
      await waitForStep(ctx, parentRun.runId, "sub", "waiting");
      const openTree = asRecord(
        (await ctx.api("GET", `/api/workflow-runs/${parentRun.runId}/tree`)).json,
      );
      const treeRuns = asRecords(openTree, "runs");
      expect(
        openTree.hasOpenWork === true && treeRuns.length === 2,
        `a live tree has open work: ${JSON.stringify(openTree)}`,
      );
      const childRunId = String(treeRuns.find((run) => run.id !== parentRun.runId)?.id);
      expectStatus(
        await ctx.api("POST", `/api/workflow-runs/${parentRun.runId}/cancel`, {
          body: { reason: "cascade" },
        }),
        [200],
        "cancel the parent of a sub-workflow",
      );
      const childDetail = await getRunDetail(ctx, childRunId);
      expect(childDetail.run.status === "cancelled", "the child run is cancelled with its parent");
      const settled = asRecord(
        (await ctx.api("GET", `/api/workflow-runs/${parentRun.runId}/tree`)).json,
      );
      expect(
        settled.hasOpenWork === false &&
          asRecords(settled, "runs").every((run) => run.status === "cancelled"),
        `the cancelled tree has no open work: ${JSON.stringify(settled)}`,
      );

      // Cancelling a child alone fails the parent step that started it.
      const parent2 = await triggerWorkflow(ctx, parentId, {}, { agentId: workerId });
      await waitForStep(ctx, parent2.runId, "sub", "waiting");
      const tree2 = asRecords(
        asRecord((await ctx.api("GET", `/api/workflow-runs/${parent2.runId}/tree`)).json),
        "runs",
      );
      const child2 = String(tree2.find((run) => run.id !== parent2.runId)?.id);
      expectStatus(
        await ctx.api("POST", `/api/workflow-runs/${child2}/cancel`, {
          body: { reason: "child only" },
        }),
        [200],
        "cancel only the child run",
      );
      const parentFailed = await waitForRun(
        ctx,
        parent2.runId,
        "failed",
        20_000,
        "parent of a cancelled child",
      );
      expect(
        String(parentFailed.run.error).includes("cancelled") &&
          !parentFailed.steps.some((step) => step.nodeId === "after"),
        `a cancelled child fails the parent: ${String(parentFailed.run.error)}`,
      );

      // Parked: a long time wait that nobody cancels. The strict state-surface gate expects a
      // waiting run and a waiting step to be left in the database after the scenarios.
      const parkId = await createWorkflow(
        ctx,
        "cancel-park",
        {
          nodes: [{ id: "park", type: "wait", config: { mode: "time", durationMs: 3_600_000 } }],
        },
        {},
        workerId,
      );
      const parkRun = await triggerWorkflow(ctx, parkId, {}, { agentId: workerId });
      await waitForStep(ctx, parkRun.runId, "park", "waiting");
      await waitForRun(ctx, parkRun.runId, "waiting", 20_000, "parked time-wait run");
    } finally {
      await connection.close();
    }
  },
};
