import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { cleanupStack, putConfig, reloadConfig } from "./platform-helpers";
import { expectRunOk, registerAgent, runScript } from "./script-helpers";
import {
  createWorkflow,
  deleteWorkflowQuietly,
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

/**
 * The hourly `org.activity` rollup counts script runs, HITL requests and workflow steps in
 * memory and flushes on the ticker and at shutdown. A restart is the shutdown flush: with
 * telemetry on, the rollup reaches the sink with the activity's counts and none of its
 * content; with telemetry off, nothing is counted or sent.
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
      expect(body.source === "api-server", `org.activity comes from the api-server: ${body.source}`);
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
