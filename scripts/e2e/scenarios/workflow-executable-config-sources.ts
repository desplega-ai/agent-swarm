// code-match `config.code` and the string form of wait `config.filter` are compiled as
// JavaScript, so like a script body they may interpolate only input, workflow, swarm and
// run values. Trigger data, aliases rooted at trigger or an upstream output, and foreach
// items must reach them as runtime values: the step fails before compilation otherwise.
import { expect } from "../http";
import type { Scenario } from "../run";
import {
  createWorkflow,
  hasStep,
  type RunDetail,
  registerWorker,
  stepOf,
  TERMINAL_RUN_STATUSES,
  triggerWorkflow,
  type WorkflowDef,
  waitForRun,
} from "./workflow-helpers";

// Not equal to 'abc', but spliced into a quoted literal it makes the comparison true.
const TAUTOLOGY = "zzz' || 'a' === 'a";
const REJECTED = "Executable source interpolation failed";

const onTrue = (id: string) => ({
  id,
  type: "script",
  config: { runtime: "bash", script: "echo matched" },
});

const CASES: Record<string, { definition: WorkflowDef; failedNode?: string; config: string }> = {
  trigger: {
    failedNode: "cm",
    config: "config.code",
    definition: {
      nodes: [
        {
          id: "cm",
          type: "code-match",
          config: { code: "(input) => 'abc' === '{{trigger.x}}'", outputPorts: ["true", "false"] },
          next: { true: "hit" },
        },
        onTrue("hit"),
      ],
    },
  },
  alias: {
    failedNode: "cm",
    config: "config.code",
    definition: {
      nodes: [
        {
          id: "cm",
          type: "code-match",
          inputs: { v: "trigger.x" },
          config: { code: "(input) => 'abc' === '{{v}}'", outputPorts: ["true", "false"] },
          next: { true: "hit" },
        },
        onTrue("hit"),
      ],
    },
  },
  item: {
    // The per-item body step fails; the foreach node itself only counts it.
    config: "config.code",
    definition: {
      nodes: [
        {
          id: "fe",
          type: "foreach",
          inputs: { rows: "trigger.rows" },
          config: {
            over: "{{rows}}",
            itemKey: "id",
            body: {
              type: "code-match",
              config: {
                code: "(input) => 'abc' === '{{item.x}}' ? 'yes' : 'no'",
                outputPorts: ["yes", "no"],
              },
            },
          },
        },
      ],
    },
  },
  waitFilter: {
    failedNode: "w",
    config: "config.filter",
    definition: {
      nodes: [
        {
          id: "w",
          type: "wait",
          config: {
            mode: "event",
            eventName: "e2e.executable-config",
            filter: "(payload) => payload.id === '{{trigger.x}}'",
            timeoutMs: 60_000,
          },
          next: "hit",
        },
        onTrue("hit"),
      ],
    },
  },
};

function stepErrors(detail: RunDetail): string {
  return detail.steps.map((step) => String(step.error ?? "")).join("\n");
}

export const workflowExecutableConfigSources: Scenario = {
  name: "workflow-executable-config-sources",
  order: 311,
  async run(ctx) {
    const workerId = await registerWorker(ctx, "wf-exec-src");
    const trigger = { x: TAUTOLOGY, rows: [{ id: "r1", x: TAUTOLOGY }] };

    // Control: the same comparison reading the trigger at runtime routes on data.
    const controlId = await createWorkflow(
      ctx,
      "wf-exec-src-control",
      {
        nodes: [
          {
            id: "cm",
            type: "code-match",
            config: {
              code: "(input) => input.trigger.x === 'abc'",
              outputPorts: ["true", "false"],
            },
            next: { true: "hit" },
          },
          onTrue("hit"),
        ],
      },
      {},
      workerId,
    );
    const control = await triggerWorkflow(ctx, controlId, trigger, { agentId: workerId });
    const controlDetail = await waitForRun(ctx, control.runId, "completed", 30_000, "control run");
    expect(stepOf(controlDetail, "cm").nextPort === "false", "control code-match routed on data");
    expect(!hasStep(controlDetail, "hit"), "control took the true branch");

    // Control: an allowed source still interpolates into code-match code.
    const allowedId = await createWorkflow(
      ctx,
      "wf-exec-src-allowed",
      {
        nodes: [
          {
            id: "cm",
            type: "code-match",
            config: {
              code: "(input) => input.run.id === '{{run.id}}'",
              outputPorts: ["true", "false"],
            },
            next: { true: "hit" },
          },
          onTrue("hit"),
        ],
      },
      {},
      workerId,
    );
    const allowed = await triggerWorkflow(ctx, allowedId, trigger, { agentId: workerId });
    const allowedDetail = await waitForRun(ctx, allowed.runId, "completed", 30_000, "allowed run");
    expect(
      stepOf(allowedDetail, "cm").nextPort === "true",
      "allowed {{run.id}} token was not interpolated into code-match code",
    );

    for (const [name, spec] of Object.entries(CASES)) {
      const workflowId = await createWorkflow(
        ctx,
        `wf-exec-src-${name}`,
        spec.definition,
        {},
        workerId,
      );
      const { runId } = await triggerWorkflow(ctx, workflowId, trigger, { agentId: workerId });
      const detail = await waitForRun(ctx, runId, TERMINAL_RUN_STATUSES, 30_000, `${name} run`);
      const errors = stepErrors(detail);
      expect(
        errors.includes(REJECTED) && errors.includes(spec.config),
        `${name}: ${spec.config} with run-data tokens was not rejected: ${errors.slice(0, 300)}`,
      );
      expect(!hasStep(detail, "hit"), `${name}: the true branch ran`);
      if (spec.failedNode) {
        expect(
          String(stepOf(detail, spec.failedNode).status) === "failed",
          `${name}: node ${spec.failedNode} did not fail`,
        );
      }
    }
  },
};
