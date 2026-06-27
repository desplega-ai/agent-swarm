import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolRegistrar } from "@swarm/mcp-tool";
import { getWorkflow, getWorkflowRun } from "@swarm/storage";
import { getExecutorRegistry, startWorkflowExecution, TriggerSchemaError } from "@swarm/workflows";
import { z } from "zod";

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
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        runId: z.string().optional(),
        skipped: z.boolean().optional(),
        validationErrors: z.array(z.string()).optional(),
        triggerSchema: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async ({ id, triggerData }) => {
      try {
        const workflow = getWorkflow(id);
        if (!workflow) {
          return {
            content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
            structuredContent: { success: false, message: `Workflow not found: ${id}` },
          };
        }
        if (!workflow.enabled) {
          return {
            content: [{ type: "text" as const, text: `Workflow "${workflow.name}" is disabled.` }],
            structuredContent: {
              success: false,
              message: `Workflow "${workflow.name}" is disabled.`,
            },
          };
        }
        const runId = await startWorkflowExecution(
          workflow,
          triggerData ?? {},
          getExecutorRegistry(),
        );

        // Check if the run was skipped due to cooldown
        const run = getWorkflowRun(runId);
        const skipped = run?.status === "skipped";

        if (skipped) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Workflow "${workflow.name}" skipped (cooldown active) — run ID: ${runId}.`,
              },
            ],
            structuredContent: {
              success: true,
              message: `Workflow "${workflow.name}" skipped (cooldown).`,
              runId,
              skipped: true,
            },
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Triggered workflow "${workflow.name}" — run ID: ${runId}.`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Triggered workflow "${workflow.name}".`,
            runId,
            skipped: false,
          },
        };
      } catch (err) {
        if (err instanceof TriggerSchemaError) {
          // Re-fetch workflow so we can echo its triggerSchema for self-correction.
          // (Workflow existence was already proven above; this is best-effort.)
          const workflow = getWorkflow(id);
          const bulleted = err.validationErrors.map((e) => `- ${e}`).join("\n");
          const schemaBlock = workflow?.triggerSchema
            ? `\n\nExpected triggerSchema:\n\`\`\`json\n${JSON.stringify(workflow.triggerSchema, null, 2)}\n\`\`\``
            : "";
          const text =
            `Trigger payload did not match the workflow's triggerSchema:\n${bulleted}` +
            schemaBlock;
          return {
            content: [{ type: "text" as const, text }],
            structuredContent: {
              success: false,
              message: `Trigger payload did not match the workflow's triggerSchema (${err.validationErrors.length} error${err.validationErrors.length === 1 ? "" : "s"}).`,
              validationErrors: err.validationErrors,
              triggerSchema: workflow?.triggerSchema,
            },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Failed: ${err}` }],
          structuredContent: { success: false, message: String(err) },
        };
      }
    },
  );
};
