import { asRecord, expect, expectStatus, pollUntil } from "../http";
import { SkipError } from "../report";
import type { Scenario, ScenarioContext } from "../run";

async function execute(ctx: ScenarioContext, runtime: "bash" | "ts") {
  const marker = `workflow-${ctx.nonce}`;
  const secondScript =
    runtime === "bash" ? `printf '%s\\n' "$0" "$@"` : "console.log(Bun.argv.at(-1))";
  const create = await ctx.api("POST", "/api/workflows", {
    body: {
      name: `e2e-${runtime}-${ctx.nonce}`,
      definition: {
        nodes: [
          {
            id: "first",
            type: "script",
            config: {
              runtime,
              script: runtime === "bash" ? `echo ${marker}` : `console.log("${marker}")`,
            },
            next: "second",
          },
          {
            id: "second",
            type: "script",
            inputs: { upstream: "first.stdout" },
            config: { runtime, script: secondScript, args: ["{{upstream}}"] },
          },
        ],
      },
    },
  });
  expectStatus(create, [201], `create ${runtime} workflow`);
  const workflowId = asRecord(create.json).id;
  expect(typeof workflowId === "string", "Workflow response has no id");
  const trigger = await ctx.api("POST", `/api/workflows/${workflowId}/trigger`, { body: {} });
  expectStatus(trigger, [201], `trigger ${runtime} workflow`);
  const runId = asRecord(trigger.json).runId;
  expect(typeof runId === "string", "Workflow trigger response has no runId");

  let detail: Record<string, unknown> | undefined;
  const terminal = await pollUntil(async () => {
    const response = await ctx.api("GET", `/api/workflow-runs/${runId}`);
    expectStatus(response, [200], "read workflow run");
    detail = asRecord(response.json);
    const status = asRecord(detail.run).status;
    return ["completed", "failed", "cancelled", "skipped"].includes(String(status));
  }, 60_000);
  expect(terminal && detail, "Workflow run did not become terminal within 60 seconds");
  return { detail, marker };
}

export const workflowScriptNode: Scenario = {
  name: "workflow-script-node",
  async run(ctx) {
    let result = await execute(ctx, "bash");
    let run = asRecord(result.detail.run);
    if (run.status === "failed" && JSON.stringify(result.detail).toLowerCase().includes("bash")) {
      result = await execute(ctx, "ts");
      run = asRecord(result.detail.run);
    }
    if (
      run.status === "failed" &&
      JSON.stringify(result.detail).includes("Script execution is unavailable")
    ) {
      throw new SkipError("Inline script nodes are unavailable in this environment");
    }
    expect(
      run.status === "completed",
      `Workflow finished with status ${String(run.status)}: ${JSON.stringify(result.detail).slice(0, 500)}`,
    );
    const steps = result.detail.steps;
    expect(Array.isArray(steps), "Workflow detail has no steps array");
    const second = steps.map(asRecord).find((step) => step.nodeId === "second");
    expect(
      second && JSON.stringify(second.output).includes(result.marker),
      "Second node output does not contain the first node marker",
    );
  },
};
