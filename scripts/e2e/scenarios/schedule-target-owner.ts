// A schedule fires as the agent that created it, so only that agent or a lead may change
// what it runs (targetType, taskTemplate, workflowId, scriptName, scriptArgs, params), over
// MCP and HTTP. Other agents keep every other edit; the operator keeps every edit.
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerLead, retireAgent } from "./core-helpers";
import { callToolErr, callToolOk, createWorkflow, registerWorker } from "./workflow-helpers";

// 03:00 on 1 January: never due while the suite runs.
const YEARLY = "0 3 1 1 *";
const DENIED = "runs as the agent that created it";

export const scheduleTargetOwner: Scenario = {
  name: "schedule-target-owner",
  order: 352,
  async run(ctx) {
    const ownerId = await registerWorker(ctx, "sched-owner");
    const otherId = await registerWorker(ctx, "sched-other");
    const leadId = await registerLead(ctx, "sched-target");
    const owner = await ctx.connectMcp(ownerId);
    const other = await ctx.connectMcp(otherId);
    let scheduleId: string | undefined;

    try {
      const workflowId = await createWorkflow(
        ctx,
        "sched-owner-target",
        { nodes: [{ id: "tick", type: "script", config: { runtime: "bash", script: "echo" } }] },
        {},
        otherId,
      );
      const created = await ctx.api("POST", "/api/schedules", {
        agentId: ownerId,
        body: {
          name: `e2e-sched-owner-${ctx.nonce}`,
          cronExpression: YEARLY,
          taskTemplate: "owner work",
        },
      });
      expectStatus(created, [201], "the owner creates a schedule");
      scheduleId = asString(asRecord(created.json).id, "schedule id");
      expect(asRecord(created.json).createdByAgentId === ownerId, "the schedule runs as its owner");

      const row = () =>
        ctx.db.get<{ targetType: string; taskTemplate: string; cronExpression: string }>(
          "SELECT targetType, taskTemplate, cronExpression FROM scheduled_tasks WHERE id = ?",
          [scheduleId as string],
        );

      // Another agent cannot change what the schedule runs, on any surface.
      await callToolErr(
        other,
        "update-schedule",
        { scheduleId, taskTemplate: "other work" },
        DENIED,
      );
      await callToolErr(
        other,
        "patch-schedule",
        { scheduleId, targetType: "workflow", workflowId },
        DENIED,
      );
      for (const [method, body] of [
        ["PATCH", { taskTemplate: "other work" }],
        ["PATCH", { params: { topic: "other" } }],
        ["PUT", { targetType: "workflow", workflowId }],
      ] as const) {
        const denied = await ctx.api(method, `/api/schedules/${scheduleId}`, {
          agentId: otherId,
          body,
        });
        expectStatus(denied, [403], `another agent's ${method} ${Object.keys(body).join(",")}`);
        expect(String(asRecord(denied.json).error).includes(DENIED), "the 403 says why");
      }
      expect(
        row()?.targetType === "agent-task" && row()?.taskTemplate === "owner work",
        `refused edits left the target alone: ${JSON.stringify(row())}`,
      );

      // It keeps every other edit, and restating the current target is not a change.
      await callToolOk(other, "update-schedule", {
        scheduleId,
        cronExpression: "0 4 1 1 *",
        taskTemplate: "owner work",
      });
      expect(row()?.cronExpression === "0 4 1 1 *", "another agent changed the timing");

      // The owner, a lead and the operator may change the target.
      await callToolOk(owner, "update-schedule", { scheduleId, taskTemplate: "owner v2" });
      expect(row()?.taskTemplate === "owner v2", "the owner changed the template");
      expectStatus(
        await ctx.api("PATCH", `/api/schedules/${scheduleId}`, {
          agentId: leadId,
          body: { targetType: "workflow", workflowId },
        }),
        [200],
        "a lead retargets the schedule",
      );
      expect(row()?.targetType === "workflow", "the lead's retarget persisted");
      expectStatus(
        await ctx.api("PATCH", `/api/schedules/${scheduleId}`, {
          body: { targetType: "agent-task", taskTemplate: "operator work" },
        }),
        [200],
        "the operator retargets the schedule",
      );
      expect(row()?.taskTemplate === "operator work", "the operator's retarget persisted");
    } finally {
      if (scheduleId) await ctx.api("DELETE", `/api/schedules/${scheduleId}`);
      await owner.close();
      await other.close();
      await retireAgent(ctx, leadId);
    }
  },
};
