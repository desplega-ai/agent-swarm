// Workflow `input` values of the form `${VAR}` and `secret.NAME` resolve with the
// API server's own env and global secrets. Storing them, or changing the
// definition of a workflow that stores them, needs config.read.secrets. The
// operator key has it; a non-lead worker does not. Dummy values only.
import { asRecord, asString, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario } from "../run";
import { registerLead, retireAgent } from "./core-helpers";
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
    // Workflow tools are lead-only for agents, so the MCP calls go through a lead.
    const leadId = await registerLead(ctx, "wf-mcp");
    let connection: McpConnection | undefined;
    let workerConnection: McpConnection | undefined;
    // The operator key through the script bridge with an agent id nobody registered: the
    // operator, which passes the workflow write gate but holds no config.read.secrets as an agent.
    const ghostId = crypto.randomUUID();
    const workflowIds: string[] = [];

    const scriptNode = (env: Record<string, string>): WorkflowNodeDef => ({
      id: "s",
      type: "script",
      config: { runtime: "bash", script: 'printf %s "$B" | rev', env, timeout: 10_000 },
    });
    // A non-lead agent is refused at the workflow write gate, before any secret-ref check.
    const gateDenied = "requires the lead agent, operator, or user";
    // A caller that passes the write gate but lacks config.read.secrets is refused for refs.
    const secretsDenied = "config.read.secrets";

    const bridgeDenied = async (tool: string, args: Record<string, unknown>) => {
      const response = await ctx.api("POST", "/api/mcp-bridge", {
        agentId: ghostId,
        body: { tool, args },
      });
      expectStatus(response, [200], `bridge ${tool}`);
      expect(
        asRecord(response.json).success === false && response.text.includes(secretsDenied),
        `bridged ${tool} was not refused for ${secretsDenied}: ${response.text.slice(0, 300)}`,
      );
    };

    try {
      connection = await ctx.connectMcp(leadId);
      workerConnection = await ctx.connectMcp(workerId);
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

      // A non-lead worker cannot write workflows at all, so it cannot store env or secret refs.
      await bridgeDenied("create-workflow", {
        name: `wf-input-refs-secret-${ctx.nonce}`,
        definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
        input: { b: `secret.${secretKey}` },
      });
      await bridgeDenied("create-workflow", {
        name: `wf-input-refs-env-${ctx.nonce}`,
        definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: env-ref syntax under test
        input: { b: "${HOME}" },
      });

      // The worker is refused at the write gate whatever the input holds.
      await callToolErr(
        workerConnection,
        "create-workflow",
        {
          name: `wf-input-refs-gate-${ctx.nonce}`,
          definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
          input: { b: `secret.${secretKey}` },
        },
        gateDenied,
      );

      // Control: the lead may write literal input.
      const literal = await callToolOk(connection, "create-workflow", {
        name: `wf-input-refs-literal-${ctx.nonce}`,
        definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
        input: { b: "literal" },
      });
      const literalId = asString(asRecord(literal.structured.workflow).id, "literal workflow id");
      workflowIds.push(literalId);
      await bridgeDenied("update-workflow", { id: literalId, input: { b: `secret.${secretKey}` } });

      // The worker cannot rewire the operator workflow that stores a secret ref.
      await bridgeDenied("patch-workflow-node", {
        id: opWorkflowId,
        nodeId: "s",
        config: scriptNode({ B: "{{input.b}}" }).config,
      });
      await bridgeDenied("patch-workflow", {
        id: opWorkflowId,
        delete: ["s"],
        create: [{ ...scriptNode({}), id: "t" }],
      });
      await bridgeDenied("update-workflow", {
        id: opWorkflowId,
        definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
      });
      // Control: the lead may edit without touching the definition.
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
          String(asRecord(response.json).error).includes(gateDenied),
          `${label}: 403 lacks the ${gateDenied} reason`,
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

      // Control: the lead may store a literal param; the worker may not rewrite it to a ref.
      const literalParams = await ctx.api("POST", "/api/workflows", {
        agentId: leadId,
        body: {
          name: `wf-input-refs-param-literal-${ctx.nonce}`,
          definition: { nodes: [scriptNode({ B: "{{input.b}}" })] },
          input: exactToken,
          params: { p: "literal" },
        },
      });
      expectStatus(literalParams, [201], "lead HTTP create with a literal param");
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
        await ctx.api("PATCH", `/api/workflows/${literalParamsId}`, {
          agentId: leadId,
          body: { params: { p: "other-literal" } },
        }),
        [200],
        "lead HTTP patch to another literal param",
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
      await bridgeDenied("update-workflow", { id: storedParamsId, input: exactToken });
      await httpDenied(
        "PUT",
        `/api/workflows/${storedParamsId}`,
        { input: exactToken },
        "worker HTTP update of input to a token over a secret param",
      );

      // The param-borne ref is a stored ref: the worker cannot rewire it.
      await bridgeDenied("patch-workflow-node", {
        id: opParamsId,
        nodeId: "s",
        config: scriptNode({ B: "{{input.b}}" }).config,
      });
      await bridgeDenied("patch-workflow", {
        id: opParamsId,
        delete: ["s"],
        create: [{ ...scriptNode({}), id: "t" }],
      });
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
      await Promise.all([connection?.close(), workerConnection?.close(), retireAgent(ctx, leadId)]);
      for (const id of workflowIds) await deleteWorkflowQuietly(ctx, id);
      await dropSecret();
    }
  },
};
