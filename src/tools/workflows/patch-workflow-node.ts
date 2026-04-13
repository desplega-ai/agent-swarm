import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWorkflow, updateWorkflow } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { WorkflowNodePatchSchema } from "@/types";
import { applyDefinitionPatch, validateDefinition } from "@/workflows/definition";
import { snapshotWorkflow } from "@/workflows/version";

export const registerPatchWorkflowNodeTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "patch-workflow-node",
    {
      title: "Patch Workflow Node",
      annotations: { destructiveHint: false },
      description:
        "Partially update a single node in a workflow definition. " +
        "Merges the provided fields into the existing node. " +
        "Creates a version snapshot before applying changes.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow ID"),
        nodeId: z.string().describe("Node ID to update"),
        ...WorkflowNodePatchSchema.shape,
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        workflow: z.unknown().optional(),
        versionCreated: z.number().optional(),
      }),
    },
    async ({ id, nodeId, ...nodeFields }, requestInfo) => {
      try {
        const existing = getWorkflow(id);
        if (!existing) {
          return {
            content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
            structuredContent: { success: false, message: `Workflow not found: ${id}` },
          };
        }

        const patchResult = applyDefinitionPatch(existing.definition, {
          update: [{ nodeId, node: nodeFields }],
        });
        if (patchResult.errors.length > 0) {
          const msg = patchResult.errors.join("; ");
          return {
            content: [{ type: "text" as const, text: `Patch errors: ${msg}` }],
            structuredContent: { success: false, message: msg },
          };
        }

        const validation = validateDefinition(patchResult.definition);
        if (!validation.valid) {
          const msg = `Invalid definition: ${validation.errors.join("; ")}`;
          return {
            content: [{ type: "text" as const, text: msg }],
            structuredContent: { success: false, message: msg },
          };
        }

        const version = snapshotWorkflow(id, requestInfo.agentId);

        const workflow = updateWorkflow(id, { definition: patchResult.definition });
        if (!workflow) {
          return {
            content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
            structuredContent: { success: false, message: `Workflow not found: ${id}` },
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Patched node "${nodeId}" in workflow "${workflow.name}" (${id}). Version ${version.version} snapshot created.`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Patched node "${nodeId}" in workflow "${workflow.name}".`,
            workflow,
            versionCreated: version.version,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed: ${err}` }],
          structuredContent: { success: false, message: String(err) },
        };
      }
    },
  );
};
