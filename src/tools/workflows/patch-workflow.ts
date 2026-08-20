import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorizeAssetKeyWrite } from "@/be/asset-key-auth";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import type { updateWorkflow } from "@/be/db";
import {
  createToolRegistrar,
  findLongScriptTimeoutHint,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "@/tools/utils";
import type { WorkflowPatch } from "@/types";
import { AssetKeySchema, WorkflowNodePatchSchema } from "@/types";
import { getExecutorRegistry } from "@/workflows";
import { patchWorkflowDefinition } from "@/workflows/patch-definition";

export const registerPatchWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "patch-workflow",
    {
      title: "Patch Workflow Definition",
      annotations: { destructiveHint: false },
      description:
        "Partially update a workflow by creating, updating, or deleting individual nodes, " +
        "and/or by setting/clearing the trigger payload schema. " +
        "DAG operations are applied in order: delete → create → update. " +
        "`triggerSchema` is independent of DAG ops: pass an object to set/replace, " +
        "pass null to clear, or omit to leave unchanged. " +
        "Validator subset for `triggerSchema`: type, required, properties, enum, const, items. " +
        "Other JSON-Schema keywords are silently ignored. " +
        "Creates a version snapshot before applying changes.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow ID to patch"),
        key: AssetKeySchema.optional().describe("Move to a logical namespace."),
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
        triggerSchema: z
          .record(z.string(), z.unknown())
          .optional()
          .nullable()
          .describe(
            "Optional JSON-Schema describing the expected trigger payload. " +
              "Pass an object to set/replace; pass null to clear; omit to leave unchanged. " +
              "Validator subset: type, required, properties, enum, const, items.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        workflow: z.unknown().optional(),
        versionCreated: z.number().optional(),
        nodesCreated: z.number().optional(),
        nodesUpdated: z.number().optional(),
        nodesDeleted: z.number().optional(),
      }),
    },
    async ({ id, key, update, delete: del, create, onNodeFailure, triggerSchema }, requestInfo) => {
      try {
        const updatedBy =
          (await resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId)) ??
          undefined;
        const updates: Omit<Parameters<typeof updateWorkflow>[1], "definition"> = {};
        if (key !== undefined) {
          updates.key = await authorizeAssetKeyWrite(key, updatedBy);
        }
        if (triggerSchema !== undefined) {
          updates.triggerSchema = triggerSchema;
        }
        if (updatedBy !== undefined) {
          updates.updatedBy = updatedBy;
        }

        const result = await patchWorkflowDefinition({
          id,
          patch: {
            update,
            delete: del,
            create: create as WorkflowPatch["create"],
            onNodeFailure,
          },
          registry: getExecutorRegistry(),
          snapshotAgentId: requestInfo.agentId,
          updates,
        });
        if (!result.ok) {
          if (result.reason === "not_found") return toolErr(`Workflow not found: ${id}`);
          if (result.reason === "patch") {
            return toolErr(`Patch errors: ${result.errors.join("; ")}`);
          }
          return toolErr(`Invalid definition: ${result.errors.join("; ")}`);
        }
        const { workflow, version } = result;

        const timeoutAuthoredNodeIds = new Set((create ?? []).map((node) => node.id));
        for (const { nodeId, node } of update ?? []) {
          const config = node.config;
          if (
            node.type === "script" ||
            node.type === "swarm-script" ||
            (config && (Object.hasOwn(config, "timeout") || Object.hasOwn(config, "timeoutMs")))
          ) {
            timeoutAuthoredNodeIds.add(nodeId);
          }
        }
        const authoredFinalNodes = result.definition.nodes.filter((node) =>
          timeoutAuthoredNodeIds.has(node.id),
        );
        const longScriptTimeoutHint = findLongScriptTimeoutHint(authoredFinalNodes);

        return toolOk(`Patched workflow "${workflow.name}".`, {
          details: `Patched workflow "${workflow.name}" (${id}). Version ${version} snapshot created.`,
          data: {
            workflow,
            versionCreated: version ?? undefined,
            nodesCreated: create?.length ?? 0,
            nodesUpdated: update?.length ?? 0,
            nodesDeleted: del?.length ?? 0,
            ...(longScriptTimeoutHint ? { longScriptTimeoutHint } : {}),
          },
        });
      } catch (err) {
        return toolErr(String(err));
      }
    },
  );
};
