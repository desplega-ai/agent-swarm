// Workers cannot edit workflows. Stored edits from earlier versions still have
// to pass the creator-identity check, including after a later trusted save.
import { loadHistoricalWorkflowFixture, sql } from "../db";
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario, ScenarioContext } from "../run";
import { GATE_DENIED } from "./authz-helpers";
import { registerLead, retireAgent } from "./core-helpers";
import {
  callToolErr,
  callToolOk,
  createWorkflow,
  deleteWorkflowQuietly,
  expectRunStatus,
  outputOf,
  registerWorker,
  stepOf,
  triggerWorkflow,
  waitForStep,
} from "./workflow-helpers";

async function upsertAgentScript(ctx: ScenarioContext, agentId: string, name: string) {
  const upsert = await ctx.api("POST", "/api/scripts/upsert", {
    agentId,
    body: {
      name,
      scope: "agent",
      description: "e2e: report which script ran",
      source: `export default async () => ({ ran: ${JSON.stringify(name)} });`,
    },
  });
  expectStatus(upsert, [200], `upsert agent script ${name}`);
}

async function checkHistoricalEdits(ctx: ScenarioContext) {
  const creatorId = crypto.randomUUID();
  const editorId = crypto.randomUUID();
  const delayedId = crypto.randomUUID();
  const parentId = crypto.randomUUID();
  const childId = crypto.randomUUID();
  const eventName = `e2e.historical-edit.${ctx.nonce}`;
  const fixture = await ctx.startFixtureSut(
    await loadHistoricalWorkflowFixture({
      creatorId,
      editorId,
      workflows: [
        {
          id: delayedId,
          name: "historical edited workflow",
          historicalEdit: true,
          definition: {
            nodes: [
              {
                id: "hold",
                type: "wait",
                config: { mode: "event", scope: "run", eventName },
                next: { event: "probe" },
              },
              {
                id: "probe",
                type: "swarm-script",
                config: { scriptName: `not-installed-${ctx.nonce}`, scope: "agent" },
              },
            ],
          },
        },
        {
          id: parentId,
          name: "historical edited parent workflow",
          historicalEdit: true,
          definition: {
            nodes: [{ id: "sub", type: "sub-workflow", config: { workflowId: childId } }],
          },
        },
        {
          id: childId,
          name: "historical workflow child",
          historicalEdit: false,
          definition: {
            nodes: [{ id: "hold", type: "wait", config: { mode: "time", durationMs: 100 } }],
          },
        },
      ],
    }),
  );
  const historical = { ...ctx, api: fixture.api, db: fixture.db };
  try {
    const delayed = await triggerWorkflow(historical, delayedId, {}, { wait: false });
    await waitForStep(historical, delayed.runId, "hold", "waiting");
    expectStatus(
      await fixture.api("PATCH", `/api/workflows/${delayedId}/nodes/probe`, {
        body: { label: "saved by operator" },
      }),
      [200],
      "operator re-saves the live workflow while the run waits",
    );
    expectStatus(
      await fixture.api("POST", `/api/workflow-runs/${delayed.runId}/events`, {
        body: { name: eventName },
      }),
      [200],
      "release the historical run after the trusted save",
    );
    const detail = await expectRunStatus(historical, delayed.runId, "failed");
    expect(
      String(stepOf(detail, "probe").error).includes(`last edited by agent ${editorId}`),
      "the pinned historical editor still blocks the script after the operator saves",
    );

    const parent = await triggerWorkflow(historical, parentId);
    const parentDetail = await expectRunStatus(historical, parent.runId, "failed");
    expect(
      String(stepOf(parentDetail, "sub").error).includes(`last edited by agent ${editorId}`),
      "the historical editor blocks the parent from starting the child",
    );
    expect(
      !fixture.db.get(sql`SELECT id FROM workflow_runs WHERE "workflowId" = ${childId}`),
      "the historical parent did not create a child run",
    );
  } finally {
    await fixture.stop();
  }
}

export const workflowEditedScriptPrincipal: Scenario = {
  name: "workflow-edited-script-principal",
  order: 358,
  async run(ctx) {
    const workerId = await registerWorker(ctx, "wf-edit-principal");
    const leadId = await registerLead(ctx, "wf-edit-principal");
    let leadMcp: McpConnection | undefined;
    let workerMcp: McpConnection | undefined;
    const leadScript = `e2e-lead-probe-${ctx.nonce}`;
    const workerScript = `e2e-worker-probe-${ctx.nonce}`;
    const workflowIds: string[] = [];
    const probe = (scriptName: string, marker: string) => ({
      scriptName,
      scope: "agent",
      args: { marker },
    });

    try {
      leadMcp = await ctx.connectMcp(leadId);
      workerMcp = await ctx.connectMcp(workerId);
      await upsertAgentScript(ctx, leadId, leadScript);
      await upsertAgentScript(ctx, workerId, workerScript);

      const leadWorkflow = await createWorkflow(
        ctx,
        "wf-edit-principal-lead",
        { nodes: [{ id: "probe", type: "swarm-script", config: probe(leadScript, "a") }] },
        {},
        leadId,
      );
      workflowIds.push(leadWorkflow);

      // Control: the creator's workflow resolves the creator's agent-scoped script.
      let run = await triggerWorkflow(ctx, leadWorkflow, {}, { agentId: leadId });
      let detail = await expectRunStatus(ctx, run.runId, "completed");
      expect(asRecord(outputOf(detail, "probe").result).ran === leadScript, "lead control run");

      // A label-only change is enough to check the worker's write admission.
      await callToolErr(
        workerMcp,
        "patch-workflow-node",
        { id: leadWorkflow, nodeId: "probe", label: "worker edit" },
        GATE_DENIED,
      );
      const unchanged = await ctx.api("GET", `/api/workflows/${leadWorkflow}`);
      expectStatus(unchanged, [200], "read the workflow after the denied edit");
      const nodes = asRecords(asRecord(unchanged.json).definition, "nodes");
      expect(
        nodes[0]?.id === "probe" && nodes[0].label !== "worker edit",
        "the refused edit did not change the node",
      );

      // A lead's edit of a worker's workflow keeps the worker as the principal.
      const workerWorkflow = await createWorkflow(
        ctx,
        "wf-edit-principal-worker",
        { nodes: [{ id: "probe", type: "swarm-script", config: probe(workerScript, "a") }] },
        {},
        workerId,
      );
      workflowIds.push(workerWorkflow);
      await callToolOk(leadMcp, "patch-workflow-node", {
        id: workerWorkflow,
        nodeId: "probe",
        config: probe(workerScript, "b"),
      });
      run = await triggerWorkflow(ctx, workerWorkflow, {}, { agentId: leadId });
      detail = await expectRunStatus(ctx, run.runId, "completed");
      expect(
        asRecord(outputOf(detail, "probe").result).ran === workerScript,
        "lead-edited worker workflow did not run as its worker creator",
      );

      // The operator starts the parent without an agent identity. The child
      // inherits the parent's creator, not the identity that started the run.
      const child = await createWorkflow(ctx, "wf-edit-principal-child", {
        nodes: [{ id: "probe", type: "swarm-script", config: probe(leadScript, "a") }],
      });
      workflowIds.push(child);
      const parent = await createWorkflow(
        ctx,
        "wf-edit-principal-parent",
        { nodes: [{ id: "sub", type: "sub-workflow", config: { workflowId: child } }] },
        {},
        leadId,
      );
      workflowIds.push(parent);
      run = await triggerWorkflow(ctx, parent);
      detail = await expectRunStatus(ctx, run.runId, "completed");
      const parentRun = ctx.db.get<{ triggeredByAgentId: string | null }>(
        sql`SELECT "triggeredByAgentId" FROM workflow_runs WHERE id = ${run.runId}`,
      );
      expect(
        parentRun?.triggeredByAgentId === null,
        "the operator did not name a triggering agent",
      );
      const childOutputs = asRecord(outputOf(detail, "sub").outputs);
      expect(
        asRecord(asRecord(childOutputs.probe).result).ran === leadScript,
        "the child ran as the parent workflow's creator",
      );
    } finally {
      try {
        for (const id of workflowIds.reverse()) await deleteWorkflowQuietly(ctx, id);
      } finally {
        await Promise.all([leadMcp?.close(), workerMcp?.close(), retireAgent(ctx, leadId)]);
      }
    }
    await checkHistoricalEdits(ctx);
  },
};
