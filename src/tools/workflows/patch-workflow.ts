import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWorkflow, updateWorkflow } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import type { WorkflowDefinitionPatch } from "@/types";
import { WorkflowNodePatchSchema } from "@/types";
import { applyDefinitionPatch, validateDefinition } from "@/workflows/definition";
import { snapshotWorkflow } from "@/workflows/version";

export const registerPatchWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "patch-workflow",
    {
      title: "Patch Workflow Definition",
      annotations: { destructiveHint: false },
      description:
        "Partially update a workflow definition by creating, updating, or deleting individual nodes. " +
        "Operations are applied in order: delete → create → update. " +
        "Creates a version snapshot before applying changes.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow ID to patch"),
        update: z
          .array(
            z.object({
              nodeId: z.string(),
              node: WorkflowNodePatchSchema,
            }),
          )
          .optional()
          .describe("Nodes to update (partial merge)"),
        delete: z.array(z.string()).optional().describe("Node IDs to delete"),
        create: z
          .array(
            z.object({
              id: z.string(),
              type: z.string(),
              config: z.record(z.string(), z.unknown()),
              label: z.string().optional(),
              next: z
                .union([z.string(), z.array(z.string()), z.record(z.string(), z.string())])
                .optional(),
              inputs: z.record(z.string(), z.string()).optional(),
            }),
          )
          .optional()
          .describe("New nodes to add"),
        onNodeFailure: z
          .enum(["fail", "continue"])
          .optional()
          .describe("Update onNodeFailure behavior"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        workflow: z.unknown().optional(),
        versionCreated: z.number().optional(),
        nodesCreated: z.number().optional(),
        nodesUpdated: z.number().optional(),
        nodesDeleted: z.number().optional(),
      }),
    },
    async ({ id, update, delete: del, create, onNodeFailure }, requestInfo) => {
      try {
        const existing = getWorkflow(id);
        if (!existing) {
          return {
            content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
            structuredContent: { success: false, message: `Workflow not found: ${id}` },
          };
        }

        const patchResult = applyDefinitionPatch(existing.definition, {
          update,
          delete: del,
          create: create as WorkflowDefinitionPatch["create"],
          onNodeFailure,
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
              text: `Patched workflow "${workflow.name}" (${id}). Version ${version.version} snapshot created.`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Patched workflow "${workflow.name}".`,
            workflow,
            versionCreated: version.version,
            nodesCreated: create?.length ?? 0,
            nodesUpdated: update?.length ?? 0,
            nodesDeleted: del?.length ?? 0,
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
