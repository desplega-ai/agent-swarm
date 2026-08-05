import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import { getWorkflow, updateWorkflow } from "@/be/db";
import {
  createToolRegistrar,
  findLongScriptTimeoutHint,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "@/tools/utils";
import { WorkflowNodePatchSchema } from "@/types";
import { getExecutorRegistry } from "@/workflows";
import {
  applyDefinitionPatch,
  definitionNodeIds,
  validateDefinition,
} from "@/workflows/definition";
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
      outputSchema: swarmToolOutputSchema({
        workflow: z.unknown().optional(),
        versionCreated: z.number().optional(),
      }),
    },
    async ({ id, nodeId, ...nodeFields }, requestInfo) => {
      try {
        const existing = getWorkflow(id);
        if (!existing) {
          return toolErr(`Workflow not found: ${id}`);
        }

        const patchResult = applyDefinitionPatch(existing.definition, {
          update: [{ nodeId, node: nodeFields }],
        });
        if (patchResult.errors.length > 0) {
          const msg = patchResult.errors.join("; ");
          return toolErr(`Patch errors: ${msg}`);
        }

        const validation = validateDefinition(patchResult.definition, getExecutorRegistry(), {
          legacyNodeIds: definitionNodeIds(existing.definition),
        });
        if (!validation.valid) {
          return toolErr(`Invalid definition: ${validation.errors.join("; ")}`);
        }

        const version = snapshotWorkflow(id, requestInfo.agentId);

        const updatedBy =
          resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId) ?? undefined;
        const updateArgs: Parameters<typeof updateWorkflow>[1] = {
          definition: patchResult.definition,
        };
        if (updatedBy !== undefined) {
          updateArgs.updatedBy = updatedBy;
        }
        const workflow = updateWorkflow(id, updateArgs);
        if (!workflow) {
          return toolErr(`Workflow not found: ${id}`);
        }

        const patchedNode = patchResult.definition.nodes.find((node) => node.id === nodeId);
        const longScriptTimeoutHint = findLongScriptTimeoutHint([
          { id: nodeId, type: patchedNode?.type, config: nodeFields.config },
        ]);

        return toolOk(`Patched node "${nodeId}" in workflow "${workflow.name}".`, {
          details: `Patched node "${nodeId}" in workflow "${workflow.name}" (${id}). Version ${version.version} snapshot created.`,
          data: {
            workflow,
            versionCreated: version.version,
            ...(longScriptTimeoutHint ? { longScriptTimeoutHint } : {}),
          },
        });
      } catch (err) {
        return toolErr(String(err));
      }
    },
  );
};
