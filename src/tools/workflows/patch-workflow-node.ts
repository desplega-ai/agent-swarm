import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import {
  createToolRegistrar,
  findLongScriptTimeoutHint,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "@/tools/utils";
import { WorkflowNodePatchSchema } from "@/types";
import { getExecutorRegistry } from "@/workflows";
import { patchWorkflowDefinition } from "@/workflows/patch-definition";

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
        const updatedBy =
          (await resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId)) ??
          undefined;

        const result = await patchWorkflowDefinition({
          id,
          patch: { update: [{ nodeId, node: nodeFields }] },
          registry: getExecutorRegistry(),
          snapshotAgentId: requestInfo.agentId,
          updates: updatedBy !== undefined ? { updatedBy } : {},
        });
        if (!result.ok) {
          if (result.reason === "not_found") return toolErr(`Workflow not found: ${id}`);
          if (result.reason === "patch") {
            return toolErr(`Patch errors: ${result.errors.join("; ")}`);
          }
          return toolErr(`Invalid definition: ${result.errors.join("; ")}`);
        }
        const { workflow, version } = result;

        const patchedNode = result.definition.nodes.find((node) => node.id === nodeId);
        const longScriptTimeoutHint = findLongScriptTimeoutHint([
          { id: nodeId, type: patchedNode?.type, config: nodeFields.config },
        ]);

        return toolOk(`Patched node "${nodeId}" in workflow "${workflow.name}".`, {
          details: `Patched node "${nodeId}" in workflow "${workflow.name}" (${id}). Version ${version} snapshot created.`,
          data: {
            workflow,
            versionCreated: version ?? undefined,
            ...(longScriptTimeoutHint ? { longScriptTimeoutHint } : {}),
          },
        });
      } catch (err) {
        return toolErr(String(err));
      }
    },
  );
};
