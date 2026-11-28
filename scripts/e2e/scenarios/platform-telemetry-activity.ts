import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { cleanupStack, putConfig, reloadConfig } from "./platform-helpers";
import { expectRunOk, registerAgent, runScript } from "./script-helpers";
import {
  createWorkflow,
  deleteWorkflowQuietly,
  getRunDetail,
  respondApproval,
  triggerWorkflow,
  waitForApproval,
  waitForRun,
} from "./workflow-helpers";

type SinkBody = Record<string, unknown>;

/** The mock inference host doubles as the telemetry sink (DESPLEGA_TELEMETRY_ENDPOINT). */
function activityEvents(ctx: ScenarioContext): SinkBody[] {
  return ctx.llm
    .requestsTo("/telemetry/v1/events")
    .map((request) => asRecord(request.body))
    .filter((body) => body.event === "org.activity");
}

/** One inline script run, one human-in-the-loop workflow run answered as approved. */
async function produceActivity(ctx: ScenarioContext, agentId: string, marker: string) {
  const run = await runScript(ctx, agentId, {
    source: `// ${marker}\nexport default async () => ({ ok: "${marker}" });\n`,
    args: { marker },
  });
  expectRunOk(run, "inline script run");
  const workflowId = await createWorkflow(
    ctx,
    "telemetry-activity",
    {
      nodes: [
        {
          id: "ask",
          type: "human-in-the-loop",
          config: {
            title: `Approve ${marker}`,
            questions: [{ id: "go", type: "approval", label: `Go ${marker}?` }],
            approvers: { policy: "any" },
          },
          next: { approved: "after" },
        },
        { id: "after", type: "script", config: { runtime: "bash", script: "true" } },
      ],
    },
    {},
    agentId,
  );
  try {
    const { runId } = await triggerWorkflow(ctx, workflowId, {}, { agentId });
    const approval = await waitForApproval(ctx, runId);
    await respondApproval(ctx, String(approval.id), { go: { approved: true } });
    await waitForRun(ctx, runId, "completed");
  } finally {
    await deleteWorkflowQuietly(ctx, workflowId);
  }
}

/** Restart the SUT (the shutdown flush) and return the org.activity it sent within `waitMs`. */
async function flushByRestart(ctx: ScenarioContext, waitMs: number): Promise<SinkBody | undefined> {
  const before = activityEvents(ctx).length;
  await ctx.restartSut();
  await pollUntil(() => activityEvents(ctx).length > before, waitMs, 100);
  return activityEvents(ctx)[before];
}

/**
 * Only started workflow steps count: a three-item HITL fan-out at concurrency 1
 * starts one child, and cancelling the run leaves the two queued ones uncounted.
 * The run cancel settles the started child's approval as cancelled. A retried
 * script node counts once per attempt.
 */
async function produceStepStarts(ctx: ScenarioContext, agentId: string): Promise<void> {
  const fanOutId = await createWorkflow(
    ctx,
    "telemetry-activity-queued",
    {
      nodes: [
        {
          id: "each",
          type: "foreach",
          config: {
            over: [{ key: "a" }, { key: "b" }, { key: "c" }],
            itemKey: "key",
            concurrency: 1,
            body: {
              type: "human-in-the-loop",
              config: {
                title: "Wait",
                questions: [{ id: "go", type: "approval", label: "Go?" }],
                approvers: { policy: "any" },
              },
            },
          },
        },
      ],
    },
    {},
    agentId,
  );
  const retryId = await createWorkflow(
    ctx,
    "telemetry-activity-retry",
    {
      nodes: [
        {
          id: "flaky",
          type: "script",
          config: { runtime: "bash", script: "exit 1" },
          retry: { strategy: "static", maxRetries: 1, baseDelayMs: 1 },
        },
      ],
    },
    {},
    agentId,
  );
  try {
    const { runId } = await triggerWorkflow(ctx, fanOutId, {}, { agentId });
    await waitForApproval(ctx, runId);
    const queued = (await getRunDetail(ctx, runId)).steps.filter(
      (step) => step.nodeType === "human-in-the-loop" && step.status === "pending",
    );
    expect(queued.length === 2, `two HITL children stay queued: ${queued.length}`);
    expectStatus(
      await ctx.api("POST", `/api/workflow-runs/${runId}/cancel`, {
        body: { reason: "stop before the queued children start" },
      }),
      [200],
      "cancel the fan-out run",
    );
    const retried = await triggerWorkflow(ctx, retryId, {}, { agentId });
    await waitForRun(ctx, retried.runId, "failed");
  } finally {
    await deleteWorkflowQuietly(ctx, fanOutId);
    await deleteWorkflowQuietly(ctx, retryId);
  }
}

/**
 * The hourly `org.activity` rollup counts script runs, HITL requests and workflow steps in
 * memory and flushes on the ticker and at shutdown. A restart is the shutdown flush: with
 * telemetry on, the rollup reaches the sink with the activity's counts and none of its
 * content; with telemetry off, nothing is counted or sent, and an opt-out drops what
 * the window held before it. Queued foreach children count only once they start.
 */
export const platformTelemetryActivity: Scenario = {
  name: "platform-telemetry-activity",
  order: 643.5,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "telemetry-activity");
    const cleanup = cleanupStack(ctx);
    cleanup.add("turn telemetry off", async () => {
      await putConfig(ctx, { key: "ANONYMIZED_TELEMETRY", value: "false" });
      await reloadConfig(ctx);
    });
    try {
      expectStatus(
        await ctx.api("POST", "/api/telemetry/enable", { body: { via: "settings" } }),
        [200],
        "turn telemetry on",
      );
      const marker = `activity-${ctx.nonce}`;
      await produceActivity(ctx, agentId, marker);
      const before = activityEvents(ctx).length;
      await ctx.restartSut();
      expect(
        await pollUntil(() => activityEvents(ctx).length > before, 15_000, 100),
        "the shutdown flush sent org.activity",
      );
      const body = activityEvents(ctx)[before] ?? {};
      const props = asRecord(body.properties);
      const count = (key: string) => Number(props[key] ?? -1);
      expect(
        body.source === "api-server",
        `org.activity comes from the api-server: ${body.source}`,
      );
      expect(
        count("script_runs") >= 1 &&
          count("script_runs_completed") >= 1 &&
          count("script_runs_inline") >= 1 &&
          count("script_runs_native") + count("script_runs_quickjs") === count("script_runs") &&
          count("script_runs_duration_ms_total") >= count("script_runs_duration_ms_max"),
        `script run counts: ${JSON.stringify(props)}`,
      );
      expect(
        count("hitl_requests_created") >= 1 &&
          count("hitl_requests_from_workflow") >= 1 &&
          count("hitl_requests_approved") >= 1 &&
          count("hitl_wait_ms_total") >= 0,
        `HITL counts: ${JSON.stringify(props)}`,
      );
      expect(
        count("workflow_steps_hitl") >= 1 &&
          count("workflow_steps_script") >= 1 &&
          count("workflow_steps") ===
            count("workflow_steps_agent_task") +
              count("workflow_steps_hitl") +
              count("workflow_steps_script") +
              count("workflow_steps_other"),
        `workflow step counts: ${JSON.stringify(props)}`,
      );
      expect(count("window_minutes") >= 0, "the rollup names its window");
      expect(
        !JSON.stringify(body).includes(marker),
        "the rollup carries no script source, args, output or request content",
      );

      // Opt-out drops the open window: count a run, turn telemetry off and on again with no
      // tick or restart in between, and the next shutdown sends nothing.
      expectRunOk(
        await runScript(ctx, agentId, { source: "export default async () => 1;\n" }),
        "script run before the opt-out",
      );
      await putConfig(ctx, { key: "ANONYMIZED_TELEMETRY", value: "false" });
      await reloadConfig(ctx);
      expectStatus(
        await ctx.api("POST", "/api/telemetry/enable", { body: { via: "settings" } }),
        [200],
        "turn telemetry back on",
      );
      const afterOptIn = await flushByRestart(ctx, 500);
      expect(
        afterOptIn === undefined,
        `an opt-out discards the earlier window: ${JSON.stringify(afterOptIn?.properties)}`,
      );

      // Started steps only, once per attempt.
      await produceStepStarts(ctx, agentId);
      const steps = asRecord((await flushByRestart(ctx, 15_000))?.properties);
      expect(
        steps.workflow_steps_hitl === 1 &&
          steps.workflow_steps_script === 2 &&
          steps.hitl_requests_created === 1 &&
          steps.hitl_requests_cancelled === 1,
        `one started HITL child, cancelled with its run, and two script attempts: ${JSON.stringify(steps)}`,
      );

      // Opt-out: with telemetry off nothing is counted, so the next shutdown sends nothing.
      await putConfig(ctx, { key: "ANONYMIZED_TELEMETRY", value: "false" });
      await reloadConfig(ctx);
      await produceActivity(ctx, agentId, `${marker}-off`);
      const sent = activityEvents(ctx).length;
      await ctx.restartSut();
      await Bun.sleep(500);
      expect(activityEvents(ctx).length === sent, "no org.activity is sent while telemetry is off");
    } finally {
      await cleanup.run();
    }
  },
};
