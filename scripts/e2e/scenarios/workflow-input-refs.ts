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

      // The run renders `params` into input before resolving it, so a ref can
      // ride in through a param. The gate reads the rendered input.
      const secretRef = `secret.${secretKey}`;
      // biome-ignore lint/suspicious/noTemplateCurlyInString: env-ref syntax under test
      const envRef = "${HOME}";
      const exactToken = { b: "{{p}}" };

      // Control: the operator's param-borne secret resolves, also on a step
      // that runs after a resume, and step.input keeps it redacted.
      const viaParams = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `wf-input-refs-op-params-${ctx.nonce}`,
          definition: {
            nodes: [
              { id: "w", type: "wait", config: { mode: "time", durationMs: 500 }, next: "s" },
              scriptNode({ B: "{{input.b}}" }),
            ],
          },
          input: exactToken,
          params: { p: secretRef },
        },
      });
      expectStatus(viaParams, [201], "operator creates a workflow with a param-borne secret");
      const opParamsId = asString(asRecord(viaParams.json).id, "operator params workflow id");
      workflowIds.push(opParamsId);
      const paramsRun = await expectRunStatus(
        ctx,
        (await triggerWorkflow(ctx, opParamsId)).runId,
        "completed",
      );
      expect(
        JSON.stringify(paramsRun.steps).includes(reverse(secretValue)),
        "param-borne secret input did not reach the script node",
      );
      expect(
        !JSON.stringify(paramsRun.steps.map((step) => step.input)).includes(secretValue),
        "a step persisted the resolved param-borne secret in step.input",
      );

      // HTTP as the worker itself: an agent token, not the operator key.
      const minted = await ctx.api("POST", `/api/agents/${workerId}/token`, { body: {} });
      expectStatus(minted, [200], "mint worker token");
      const workerToken = asString(asRecord(minted.json).plaintext, "worker token");
      const asWorker = (method: "POST" | "PUT" | "PATCH", path: string, body: unknown) =>
        ctx.api(method, path, { apiKey: workerToken, body });
      const httpDenied = async (
        method: "POST" | "PUT" | "PATCH",
        path: string,
        body: unknown,
        label: string,
      ) => {
        const response = await asWorker(method, path, body);
        expectStatus(response, [403], label);
        expect(
          String(asRecord(response.json).error).includes(denied),
          `${label}: 403 lacks the ${denied} reason`,
        );
      };

      await httpDenied(
        "POST",
        "/api/workflows",
        {
          name: `wf-input-refs-param-secret-${ctx.nonce}`,
          definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
          input: exactToken,
          params: { p: secretRef },
        },
        "worker HTTP create with a param-borne secret",
      );
      await httpDenied(
        "POST",
        "/api/workflows",
        {
          name: `wf-input-refs-param-split-${ctx.nonce}`,
          definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
          input: { b: "{{p}}{{q}}" },
          params: { p: "secret.", q: secretKey },
        },
        "worker HTTP create with a secret split across params",
      );

      // Control: a literal param stays open, then rewriting it to a ref is not.
      const literalParams = await asWorker("POST", "/api/workflows", {
        name: `wf-input-refs-param-literal-${ctx.nonce}`,
        definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
        input: exactToken,
        params: { p: "literal" },
      });
      expectStatus(literalParams, [201], "worker HTTP create with a literal param");
      const literalParamsId = asString(asRecord(literalParams.json).id, "literal params id");
      workflowIds.push(literalParamsId);
      await httpDenied(
        "PUT",
        `/api/workflows/${literalParamsId}`,
        { params: { p: envRef } },
        "worker HTTP update of a param to an env ref",
      );
      await httpDenied(
        "PATCH",
        `/api/workflows/${literalParamsId}`,
        { params: { p: secretRef } },
        "worker HTTP patch of a param to a secret ref",
      );
      expectStatus(
        await asWorker("PATCH", `/api/workflows/${literalParamsId}`, {
          params: { p: "other-literal" },
        }),
        [200],
        "worker HTTP patch to another literal param",
      );

      // A token in new input picks up a ref the stored params already hold.
      const storedParams = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `wf-input-refs-op-stored-params-${ctx.nonce}`,
          definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
          input: { b: "literal" },
          params: { p: secretRef },
        },
      });
      expectStatus(storedParams, [201], "operator creates a workflow with a secret param");
      const storedParamsId = asString(asRecord(storedParams.json).id, "stored params id");
      workflowIds.push(storedParamsId);
      await callToolErr(
        connection,
        "update-workflow",
        { id: storedParamsId, input: exactToken },
        denied,
      );
      await httpDenied(
        "PUT",
        `/api/workflows/${storedParamsId}`,
        { input: exactToken },
        "worker HTTP update of input to a token over a secret param",
      );

      // The param-borne ref is a stored ref: the worker cannot rewire it.
      await callToolErr(
        connection,
        "patch-workflow-node",
        { id: opParamsId, nodeId: "s", config: scriptNode({ B: "{{input.b}}" }).config },
        denied,
      );
      await callToolErr(
        connection,
        "patch-workflow",
        { id: opParamsId, delete: ["s"], create: [{ ...scriptNode({}), id: "t" }] },
        denied,
      );
      await httpDenied(
        "PATCH",
        `/api/workflows/${opParamsId}/nodes/s`,
        { config: scriptNode({}).config },
        "worker HTTP node patch over a param-borne secret",
      );
      await httpDenied(
        "PUT",
        `/api/workflows/${opParamsId}`,
        { definition: { nodes: [scriptNode({ B: "{{input.b}}" })] } },
        "worker HTTP definition update over a param-borne secret",
      );
    } finally {
      await connection.close();
      for (const id of workflowIds) await deleteWorkflowQuietly(ctx, id);
      await dropSecret();
    }
  },
};
