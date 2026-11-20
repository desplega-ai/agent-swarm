// A workflow's swarm-script nodes run as its creator. Any agent may edit a
// workflow, so the creator's identity holds only while the last edit came from
// the creator, a lead or a person: after another worker's edit the node fails
// instead of running as the creator.
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { registerLead, retireAgent } from "./core-helpers";
import {
  callToolOk,
  createWorkflow,
  deleteWorkflowQuietly,
  expectRunStatus,
  outputOf,
  registerWorker,
  stepOf,
  triggerWorkflow,
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

export const workflowEditedScriptPrincipal: Scenario = {
  name: "workflow-edited-script-principal",
  order: 358,
  async run(ctx) {
    const leadId = await registerLead(ctx, "wf-edit-principal");
    const workerId = await registerWorker(ctx, "wf-edit-principal");
    const leadMcp = await ctx.connectMcp(leadId);
    const workerMcp = await ctx.connectMcp(workerId);
    const leadScript = `e2e-lead-probe-${ctx.nonce}`;
    const workerScript = `e2e-worker-probe-${ctx.nonce}`;
    const workflowIds: string[] = [];
    const probe = (scriptName: string, marker: string) => ({
      scriptName,
      scope: "agent",
      args: { marker },
    });

    try {
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

      // A worker edits the lead's node, then starts it: it must not run as the lead.
      await callToolOk(workerMcp, "patch-workflow-node", {
        id: leadWorkflow,
        nodeId: "probe",
        config: probe(leadScript, "b"),
      });
      run = await triggerWorkflow(ctx, leadWorkflow, {}, { agentId: workerId });
      detail = await expectRunStatus(ctx, run.runId, "failed");
      const step = stepOf(detail, "probe");
      expect(
        String(step.error).includes("last edited by agent"),
        `worker-edited node did not fail on the edit: ${String(step.error).slice(0, 300)}`,
      );
      expect(
        !JSON.stringify(detail.steps).includes(`"ran":"${leadScript}"`),
        "worker-edited node ran the lead's agent-scoped script",
      );

      // The creator saving the workflow again restores its own identity.
      await callToolOk(leadMcp, "patch-workflow-node", {
        id: leadWorkflow,
        nodeId: "probe",
        config: probe(leadScript, "c"),
      });
      run = await triggerWorkflow(ctx, leadWorkflow, {}, { agentId: workerId });
      detail = await expectRunStatus(ctx, run.runId, "completed");
      expect(asRecord(outputOf(detail, "probe").result).ran === leadScript, "creator re-save");

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
    } finally {
      for (const id of workflowIds) await deleteWorkflowQuietly(ctx, id);
      await leadMcp.close();
      await workerMcp.close();
      await retireAgent(ctx, leadId);
    }
  },
};
