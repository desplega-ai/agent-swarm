import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorizeAssetKeyWrite } from "@/be/asset-key-auth";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import { getWorkflow } from "@/be/db";
import {
  createToolRegistrar,
  findLongScriptTimeoutHint,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "@/tools/utils";
import {
  AssetKeySchema,
  CooldownConfigSchema,
  InputValueSchema,
  TriggerConfigSchema,
  WorkflowDefinitionSchema,
} from "@/types";
import { getExecutorRegistry } from "@/workflows";
import { definitionNodeIds, validateDefinition } from "@/workflows/definition";
import { snapshotAndUpdateWorkflow } from "@/workflows/version";

export const registerUpdateWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "update-workflow",
    {
      title: "Update Workflow",
      annotations: { destructiveHint: false },
      description:
        "Update an existing workflow's name, description, definition, triggers, cooldown, input, triggerSchema, or enabled state. " +
        "Creates a version snapshot before applying changes. " +
        "TRIGGER SCHEMA: pass 'triggerSchema' as a JSON-Schema object to set/replace, or 'null' to clear. " +
        "Supported JSON-Schema keywords: type, required, properties, enum, const, items (recursive into arrays). " +
        "Other JSON-Schema keywords (oneOf/anyOf/$ref/pattern/format/additionalProperties) are silently ignored. " +
        "WEBHOOK VERIFICATION: webhook triggers use hmacSecret for all verification formats. " +
        "Omit verification for legacy HMAC-SHA256 over the raw body with fallback header scanning; " +
        "or set verification to { format: 'hmac-sha256', header }, { format: 'timestamped-hmac-sha256', header, toleranceSeconds? }, " +
        "or { format: 'token-equality', header }.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow ID to update"),
        key: AssetKeySchema.optional().describe("Move to a logical namespace."),
        name: z.string().optional().describe("New name for the workflow"),
        description: z.string().optional().describe("New description"),
        definition: WorkflowDefinitionSchema.optional().describe("New workflow definition"),
        triggers: z
          .array(TriggerConfigSchema)
          .optional()
          .describe(
            "New trigger configurations. Webhook verification formats: legacy omitted verification, hmac-sha256, timestamped-hmac-sha256, token-equality.",
          ),
        cooldown: CooldownConfigSchema.optional()
          .nullable()
          .describe("New cooldown configuration (null to remove)"),
        input: z
          .record(z.string(), InputValueSchema)
          .optional()
          .nullable()
          .describe("New input values (null to remove)"),
        dir: z
          .string()
          .min(1)
          .startsWith("/")
          .optional()
          .nullable()
          .describe("Default working directory for all agent-task nodes (null to remove)"),
        vcsRepo: z
          .string()
          .min(1)
          .optional()
          .nullable()
          .describe("Default VCS repo for all agent-task nodes (null to remove)"),
        enabled: z.boolean().optional().describe("Enable or disable the workflow"),
        triggerSchema: z
          .record(z.string(), z.unknown())
          .optional()
          .nullable()
          .describe(
            "New trigger payload JSON-Schema (null to clear). " +
              "Supported keywords: type, required, properties, enum, const, items. " +
              "Other JSON-Schema keywords are silently ignored.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        workflow: z.unknown().optional(),
        versionCreated: z.number().optional(),
      }),
    },
    async (
      {
        id,
        key,
        name,
        description,
        definition,
        triggers,
        cooldown,
        input,
        dir,
        vcsRepo,
        enabled,
        triggerSchema,
      },
      requestInfo,
    ) => {
      try {
        // Check workflow exists
        const existing = await getWorkflow(id);
        if (!existing) {
          return toolErr(`Workflow not found: ${id}`);
        }

        // Validate new definition if provided
        if (definition) {
          const validation = validateDefinition(definition, getExecutorRegistry(), {
            legacyNodeIds: definitionNodeIds(existing.definition),
          });
          if (!validation.valid) {
            return toolErr(`Invalid definition: ${validation.errors.join("; ")}`);
          }
        }

        const updatedBy =
          (await resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId)) ??
          undefined;
        const assetKey =
          key === undefined ? undefined : await authorizeAssetKeyWrite(key, updatedBy);
        // Snapshot + update in one transaction: concurrent full updates would
        // otherwise allocate the same version number, and the loser would
        // fail (or worse, commit with no history row).
        const { workflow, version } = await snapshotAndUpdateWorkflow(
          id,
          {
            key: assetKey,
            name,
            description,
            definition,
            triggers,
            cooldown: cooldown === null ? null : cooldown,
            input: input === null ? null : input,
            dir: dir === null ? null : dir,
            vcsRepo: vcsRepo === null ? null : vcsRepo,
            enabled,
            triggerSchema: triggerSchema === null ? null : triggerSchema,
            updatedBy,
          },
          { changedByAgentId: requestInfo.agentId },
        );
        if (!workflow) {
          return toolErr(`Workflow not found: ${id}`);
        }
        const longScriptTimeoutHint = definition
          ? findLongScriptTimeoutHint(definition.nodes)
          : undefined;
        return toolOk(`Updated workflow "${workflow.name}".`, {
          details: `Updated workflow "${workflow.name}" (${id}). Version ${version.version} snapshot created.`,
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
