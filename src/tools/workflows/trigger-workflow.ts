import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import { getWorkflow, getWorkflowRun } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { getExecutorRegistry, startWorkflowExecution } from "@/workflows";
import { TriggerSchemaError } from "@/workflows/engine";

export const registerTriggerWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "trigger-workflow",
    {
      title: "Trigger Workflow",
      annotations: { destructiveHint: false },
      description:
        "Manually trigger a workflow execution, optionally passing trigger data as context. Respects cooldown configuration. " +
        "If the workflow has a triggerSchema, the payload is validated first; on failure, the response includes structured validationErrors plus the workflow's triggerSchema for self-correction.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow ID to trigger"),
        triggerData: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional data to pass as trigger context to the workflow"),
      }),
      outputSchema: swarmToolOutputSchema({
        runId: z.string().optional(),
        skipped: z.boolean().optional(),
        validationErrors: z.array(z.string()).optional(),
        triggerSchema: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async ({ id, triggerData }, requestInfo) => {
      try {
        const workflow = await getWorkflow(id);
        if (!workflow) {
          return toolErr(`Workflow not found: ${id}`);
        }
        if (!workflow.enabled) {
          return toolErr(`Workflow "${workflow.name}" is disabled.`);
        }
        const runId = await startWorkflowExecution(
          workflow,
          triggerData ?? {},
          getExecutorRegistry(),
          {
            triggerType: "manual",
            requestedByUserId:
              (await resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId)) ??
              undefined,
          },
        );

        // Check if the run was skipped due to cooldown
        const run = await getWorkflowRun(runId);
        const skipped = run?.status === "skipped";

        if (skipped) {
          return toolOk(`Workflow "${workflow.name}" skipped (cooldown).`, {
            details: `Workflow "${workflow.name}" skipped (cooldown active) — run ID: ${runId}.`,
            data: { runId, skipped: true },
          });
        }

        return toolOk(`Triggered workflow "${workflow.name}".`, {
          details: `Triggered workflow "${workflow.name}" — run ID: ${runId}.`,
          data: { runId, skipped: false },
        });
      } catch (err) {
        if (err instanceof TriggerSchemaError) {
          // Re-fetch workflow so we can echo its triggerSchema for self-correction.
          // (Workflow existence was already proven above; this is best-effort.)
          const workflow = await getWorkflow(id);
          const bulleted = err.validationErrors.map((e) => `- ${e}`).join("\n");
          const schemaBlock = workflow?.triggerSchema
            ? `\n\nExpected triggerSchema:\n\`\`\`json\n${JSON.stringify(workflow.triggerSchema, null, 2)}\n\`\`\``
            : "";
          return toolErr(
            `Trigger payload did not match the workflow's triggerSchema (${err.validationErrors.length} error${err.validationErrors.length === 1 ? "" : "s"}).`,
            {
              details: `Trigger payload did not match the workflow's triggerSchema:\n${bulleted}${schemaBlock}`,
              data: {
                validationErrors: err.validationErrors,
                triggerSchema: workflow?.triggerSchema,
              },
            },
          );
        }
        return toolErr(String(err));
      }
    },
  );
};
