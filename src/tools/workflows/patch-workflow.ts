import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorizeAssetKeyWrite } from "@/be/asset-key-auth";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import { getWorkflow, updateWorkflow } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import type { WorkflowPatch } from "@/types";
import { AssetKeySchema, WorkflowNodePatchSchema } from "@/types";
import { applyDefinitionPatch, validateDefinition } from "@/workflows/definition";
import { snapshotWorkflow } from "@/workflows/version";

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
        const existing = getWorkflow(id);
        if (!existing) {
          return toolErr(`Workflow not found: ${id}`);
        }

        const patchResult = applyDefinitionPatch(existing.definition, {
          update,
          delete: del,
          create: create as WorkflowPatch["create"],
          onNodeFailure,
        });
        if (patchResult.errors.length > 0) {
          const msg = patchResult.errors.join("; ");
          return toolErr(`Patch errors: ${msg}`);
        }

        const validation = validateDefinition(patchResult.definition);
        if (!validation.valid) {
          return toolErr(`Invalid definition: ${validation.errors.join("; ")}`);
        }

        const version = snapshotWorkflow(id, requestInfo.agentId);

        const updatedBy =
          resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId) ?? undefined;
        const updateArgs: Parameters<typeof updateWorkflow>[1] = {
          definition: patchResult.definition,
        };
        if (key !== undefined) {
          updateArgs.key = authorizeAssetKeyWrite(key, updatedBy);
        }
        if (triggerSchema !== undefined) {
          updateArgs.triggerSchema = triggerSchema;
        }
        if (updatedBy !== undefined) {
          updateArgs.updatedBy = updatedBy;
        }
        const workflow = updateWorkflow(id, updateArgs);
        if (!workflow) {
          return toolErr(`Workflow not found: ${id}`);
        }

        return toolOk(`Patched workflow "${workflow.name}".`, {
          details: `Patched workflow "${workflow.name}" (${id}). Version ${version.version} snapshot created.`,
          data: {
            workflow,
            versionCreated: version.version,
            nodesCreated: create?.length ?? 0,
            nodesUpdated: update?.length ?? 0,
            nodesDeleted: del?.length ?? 0,
          },
        });
      } catch (err) {
        return toolErr(String(err));
      }
    },
  );
};
