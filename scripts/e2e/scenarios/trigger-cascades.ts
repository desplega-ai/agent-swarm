// Trigger group: cleanup cascades.
// Covers: cancel_approval_request_after_workflow_step_cancel (a cancelled human-in-the-loop
// step cancels its pending approval request).
// Unreachable: script_runs_delete_source. Only the retention sweep deletes script_runs rows,
// hourly, and only runs older than SCRIPT_RUNS_RETENTION_DAYS (at least one day).
import { sql } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";

async function approvals(ctx: ScenarioContext, runId: string) {
  const response = await ctx.api(
    "GET",
    `/api/approval-requests?${new URLSearchParams({ workflowRunId: runId })}`,
  );
  expectStatus(response, [200], "list the run's approval requests");
  return asRecords(response.json, "approvalRequests");
}

export const triggerCascades: Scenario = {
  name: "trigger-cascades",
  order: 9_380,
  async run(ctx) {
    const registered = await ctx.api("POST", "/api/agents", {
      body: { name: `trg-cascade-${ctx.nonce}`, role: "worker", status: "online" },
    });
    expectStatus(registered, [201], "register a worker");
    const workerId = asString(asRecord(registered.json).id, "worker id");
    let workflowId: string | undefined;
    try {
      let response = await ctx.api("POST", "/api/workflows", {
        agentId: workerId,
        body: {
          name: `trg-cascade-hitl-${ctx.nonce}`,
          definition: {
            nodes: [
              {
                id: "ask",
                type: "human-in-the-loop",
                config: {
                  title: `Cascade ${ctx.nonce}`,
                  questions: [{ id: "go", type: "approval", label: "Go?" }],
                  approvers: { policy: "any" },
                },
                next: { approved: "after" },
              },
              { id: "after", type: "script", config: { runtime: "bash", script: "true" } },
            ],
          },
        },
      });
      expectStatus(response, [201], "create a workflow with an approval step");
      workflowId = asString(asRecord(response.json).id, "workflow id");
      response = await ctx.api("POST", `/api/workflows/${workflowId}/trigger`, {
        agentId: workerId,
        body: {},
      });
      expectStatus(response, [201], "trigger the workflow");
      const runId = asString(asRecord(response.json).runId, "run id");

      let pending: Record<string, unknown> | undefined;
      const raised = await pollUntil(async () => {
        pending = (await approvals(ctx, runId)).find((row) => row.status === "pending");
        return pending !== undefined;
      }, 20_000);
      expect(raised && pending, "the run never raised a pending approval");
      const approvalId = asString(pending.id, "approval id");
      const stepId = asString(pending.workflowRunStepId, "approval step id");

      response = await ctx.api("POST", `/api/workflow-runs/${runId}/cancel`, {
        body: { reason: `stop ${ctx.nonce}` },
      });
      expectStatus(response, [200], "cancel the run");
      const step = ctx.db.get<{ status: string }>(
        sql`SELECT status FROM workflow_run_steps WHERE id = ${stepId}`,
      );
      expect(step?.status === "cancelled", `the approval step is cancelled: ${step?.status}`);
      const row = ctx.db.get<{
        status: string;
        resolvedAt: string | null;
        resolutionReason: string | null;
      }>(
        sql`SELECT status, "resolvedAt", "resolutionReason" FROM approval_requests
            WHERE id = ${approvalId}`,
      );
      expect(
        row?.status === "cancelled" && typeof row.resolvedAt === "string" && row.resolutionReason,
        `the pending approval is cancelled with a reason and a time: ${JSON.stringify(row)}`,
      );
      expect(
        (await approvals(ctx, runId)).every((request) => request.status !== "pending"),
        "the run has no pending approval left",
      );
      response = await ctx.api("POST", `/api/approval-requests/${approvalId}/respond`, {
        body: { responses: { go: { approved: true } }, respondedBy: "trigger-e2e" },
      });
      expect(
        response.status >= 400 && response.status < 500,
        `a cancelled approval cannot be answered: ${response.status}`,
      );
    } finally {
      if (workflowId) await ctx.api("DELETE", `/api/workflows/${workflowId}`);
      await ctx.api("POST", "/close", { agentId: workerId, body: {} });
    }
  },
};
