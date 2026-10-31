import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";

// PR #2452: every workflow run (top-level included) emits `workflow.run.finished` once it turns
// terminal, so an event-mode `wait` on another run's id resumes. Observed through the wait node,
// the same path the PR's runbook documents. Controls: a wait on an unrelated runId must not resume.
async function createWorkflow(ctx: ScenarioContext, name: string, nodes: unknown[]) {
  const created = await ctx.api("POST", "/api/workflows", {
    body: { name: `${name}-${ctx.nonce}`, definition: { nodes } },
  });
  expectStatus(created, [201], `create ${name}`);
  return String(asRecord(created.json).id);
}

async function trigger(ctx: ScenarioContext, workflowId: string): Promise<string> {
  const response = await ctx.api("POST", `/api/workflows/${workflowId}/trigger?wait=false`, {
    body: {},
  });
  expectStatus(response, [201], "trigger workflow");
  return String(asRecord(response.json).runId);
}

async function runStatus(ctx: ScenarioContext, runId: string): Promise<string> {
  const response = await ctx.api("GET", `/api/workflow-runs/${runId}`);
  expectStatus(response, [200], "read run");
  return String(asRecord(asRecord(response.json).run).status);
}

function waiter(runId: string, timeoutMs: number) {
  return [
    {
      id: "wait-for-run",
      type: "wait",
      config: {
        mode: "event",
        eventName: "workflow.run.finished",
        scope: "global",
        filter: { runId },
        timeoutMs,
      },
      next: { event: "done", timeout: "timed-out" },
    },
    { id: "done", type: "script", config: { runtime: "bash", script: "echo resumed-by-event" } },
    { id: "timed-out", type: "script", config: { runtime: "bash", script: "echo timed-out" } },
  ];
}

export const gapWorkflowRunFinished: Scenario = {
  name: "gap-workflow-run-finished",
  order: 1040,
  async run(ctx) {
    const slowOk = await createWorkflow(ctx, "gap-slow-ok", [
      { id: "s", type: "script", config: { runtime: "bash", script: "sleep 4; echo ok" } },
    ]);
    const slowFail = await createWorkflow(ctx, "gap-slow-fail", [
      { id: "s", type: "script", config: { runtime: "bash", script: "sleep 4; exit 3" } },
    ]);

    // Targets start first; the waiters register while they still run (the runbook's ordering rule).
    const okRun = await trigger(ctx, slowOk);
    const failRun = await trigger(ctx, slowFail);
    const otherRun = crypto.randomUUID();

    const waitOk = await trigger(
      ctx,
      await createWorkflow(ctx, "gap-wait-ok", waiter(okRun, 60_000)),
    );
    const waitFail = await trigger(
      ctx,
      await createWorkflow(ctx, "gap-wait-fail", waiter(failRun, 60_000)),
    );
    const waitOther = await trigger(
      ctx,
      await createWorkflow(ctx, "gap-wait-other", waiter(otherRun, 60_000)),
    );

    // Both targets turn terminal.
    const targetsDone = await pollUntil(async () => {
      const a = await runStatus(ctx, okRun);
      const b = await runStatus(ctx, failRun);
      return a === "completed" && b === "failed";
    }, 60_000);
    expect(
      targetsDone,
      `targets did not end completed/failed: ${await runStatus(ctx, okRun)} / ${await runStatus(ctx, failRun)}`,
    );

    // The waiters resume through the event, not the timeout.
    for (const [label, runId] of [
      ["completed target", waitOk],
      ["failed target", waitFail],
    ] as const) {
      const done = await pollUntil(
        async () => (await runStatus(ctx, runId)) === "completed",
        30_000,
      );
      expect(
        done,
        `waiter on the ${label} never completed (status ${await runStatus(ctx, runId)})`,
      );
      const detail = await ctx.api("GET", `/api/workflow-runs/${runId}`);
      const steps = JSON.stringify(asRecord(detail.json).steps);
      expect(
        steps.includes("resumed-by-event"),
        `waiter on the ${label} did not take the event branch`,
      );
      expect(!steps.includes("timed-out"), `waiter on the ${label} took the timeout branch`);
    }

    // Control: the waiter on an unrelated runId is still waiting.
    const other = await runStatus(ctx, waitOther);
    expect(other !== "completed" && other !== "failed", `unrelated waiter ended: ${other}`);
  },
};
