import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";

/** Runs a one-node workflow whose bash script creates `marker`, and returns the terminal run detail. */
async function runMarkerWorkflow(
  ctx: ScenarioContext,
  label: string,
  marker: string,
): Promise<Record<string, unknown>> {
  const create = await ctx.api("POST", "/api/workflows", {
    body: {
      name: `e2e-script-setting-${label}-${ctx.nonce}`,
      definition: {
        nodes: [
          {
            id: "probe",
            type: "script",
            config: { runtime: "bash", script: `touch ${marker}; echo ran` },
          },
        ],
      },
    },
  });
  expectStatus(create, [201], `create ${label} workflow`);
  const workflowId = asRecord(create.json).id;
  const trigger = await ctx.api("POST", `/api/workflows/${workflowId}/trigger`, { body: {} });
  expectStatus(trigger, [201], `trigger ${label} workflow`);
  const runId = asRecord(trigger.json).runId;

  let detail: Record<string, unknown> = {};
  const terminal = await pollUntil(async () => {
    const response = await ctx.api("GET", `/api/workflow-runs/${runId}`);
    expectStatus(response, [200], `read ${label} workflow run`);
    detail = asRecord(response.json);
    return ["completed", "failed", "cancelled", "skipped"].includes(
      String(asRecord(detail.run).status),
    );
  }, 60_000);
  expect(terminal, `${label} workflow run did not become terminal: ${await ctx.sutLog()}`);
  return detail;
}

/**
 * Inline workflow `script` nodes spawn a native subprocess, so under SCRIPT_EXECUTOR=quickjs the
 * engine refuses them before spawning, like inline `executor: "native"` and durable script runs.
 */
export const workflowScriptNodeExecutorSetting: Scenario = {
  name: "workflow-script-node-executor-setting",
  order: 448,
  async run(ctx) {
    const markerDir = mkdtempSync(join(tmpdir(), "e2e-workflow-script-setting-"));
    try {
      // Control: the default native deployment runs the node.
      const nativeMarker = join(markerDir, "native");
      const native = await runMarkerWorkflow(ctx, "native", nativeMarker);
      expect(
        asRecord(native.run).status === "completed" && existsSync(nativeMarker),
        `native workflow script node must run: ${JSON.stringify(native).slice(0, 500)}`,
      );

      await ctx.restartSut({ env: { SCRIPT_EXECUTOR: "quickjs" } });

      const quickjsMarker = join(markerDir, "quickjs");
      const quickjs = await runMarkerWorkflow(ctx, "quickjs", quickjsMarker);
      expect(
        asRecord(quickjs.run).status === "failed",
        `workflow script node must fail under quickjs: ${JSON.stringify(quickjs).slice(0, 500)}`,
      );
      expect(!existsSync(quickjsMarker), "workflow script node must not spawn under quickjs");
      expect(
        JSON.stringify(quickjs).includes("SCRIPT_EXECUTOR"),
        `refusal must name the setting: ${JSON.stringify(quickjs).slice(0, 500)}`,
      );
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
      // Later scenarios run workflow script nodes under the default executor.
      await ctx.restartSut();
    }
  },
};
