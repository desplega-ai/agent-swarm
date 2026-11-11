// Workflow `input` values of the form `${VAR}` and `secret.NAME` resolve with the
// API server's own env and global secrets. Storing them, or changing the
// definition of a workflow that stores them, needs config.read.secrets. The
// operator key has it; a non-lead worker does not. Dummy values only.
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  deleteWorkflowQuietly,
  expectRunStatus,
  registerWorker,
  setGlobalConfig,
  triggerWorkflow,
  type WorkflowNodeDef,
} from "./workflow-helpers";

const reverse = (s: string) => s.split("").reverse().join("");

export const workflowInputRefs: Scenario = {
  name: "workflow-input-refs",
  order: 357,
  async run(ctx) {
    const secretKey = `E2E_WF_REF_${ctx.nonce.toUpperCase()}`;
    const secretValue = `wfref-${ctx.nonce}`;
    const dropSecret = await setGlobalConfig(ctx, secretKey, secretValue, true);
    const workerId = await registerWorker(ctx, "wf-input-refs");
    const connection = await ctx.connectMcp(workerId);
    const workflowIds: string[] = [];

    const scriptNode = (env: Record<string, string>): WorkflowNodeDef => ({
      id: "s",
      type: "script",
      config: { runtime: "bash", script: 'printf %s "$B" | rev', env, timeout: 10_000 },
    });
    const denied = "config.read.secrets";

    try {
      // Control: the operator key may store a secret ref, and the run resolves it.
      const created = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `wf-input-refs-op-${ctx.nonce}`,
          definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
          input: { b: `secret.${secretKey}` },
        },
      });
      expectStatus(created, [201], "operator creates a workflow with a secret input");
      const opWorkflowId = asString(asRecord(created.json).id, "operator workflow id");
      workflowIds.push(opWorkflowId);
      const { runId } = await triggerWorkflow(ctx, opWorkflowId);
      const detail = await expectRunStatus(ctx, runId, "completed");
      expect(
        JSON.stringify(detail.steps).includes(reverse(secretValue)),
        "operator-authored secret input did not reach the script node",
      );

      // A non-lead worker cannot store env or secret refs.
      await callToolErr(
        connection,
        "create-workflow",
        {
          name: `wf-input-refs-secret-${ctx.nonce}`,
          definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
          input: { b: `secret.${secretKey}` },
        },
        denied,
      );
      await callToolErr(
        connection,
        "create-workflow",
        {
          name: `wf-input-refs-env-${ctx.nonce}`,
          definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
          // biome-ignore lint/suspicious/noTemplateCurlyInString: env-ref syntax under test
          input: { b: "${HOME}" },
        },
        denied,
      );

      // Control: literal input stays open to the worker.
      const literal = await callToolOk(connection, "create-workflow", {
        name: `wf-input-refs-literal-${ctx.nonce}`,
        definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
        input: { b: "literal" },
      });
      const literalId = asString(
        asRecord(literal.structured.workflow).id,
        "literal workflow id",
      );
      workflowIds.push(literalId);
      await callToolErr(
        connection,
        "update-workflow",
        { id: literalId, input: { b: `secret.${secretKey}` } },
        denied,
      );

      // The worker cannot rewire the operator workflow that stores a secret ref.
      await callToolErr(
        connection,
        "patch-workflow-node",
        { id: opWorkflowId, nodeId: "s", config: scriptNode({ B: "{{input.b}}" }).config },
        denied,
      );
      await callToolErr(
        connection,
        "patch-workflow",
        { id: opWorkflowId, delete: ["s"], create: [{ ...scriptNode({}), id: "t" }] },
        denied,
      );
      await callToolErr(
        connection,
        "update-workflow",
        { id: opWorkflowId, definition: { nodes: [scriptNode({ B: "{{input.b}}" })] } },
        denied,
      );
      // Edits that leave the definition alone stay open.
      await callToolOk(connection, "update-workflow", {
        id: opWorkflowId,
        description: `renamed ${ctx.nonce}`,
      });
    } finally {
      await connection.close();
      for (const id of workflowIds) await deleteWorkflowQuietly(ctx, id);
      await dropSecret();
    }
  },
};
