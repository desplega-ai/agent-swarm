import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorizeAssetKeyWrite } from "@/be/asset-key-auth";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import { createWorkflow } from "@/be/db";
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
import { validateDefinition } from "@/workflows/definition";

export const registerCreateWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "create-workflow",
    {
      title: "Create Workflow",
      annotations: { destructiveHint: false },
      description:
        "Create a new automation workflow. Key concepts:\n" +
        "- Nodes are linked via 'next' (string or port-based record).\n" +
        "- CROSS-NODE DATA: To use output from an upstream node, you MUST declare an 'inputs' mapping on the downstream node. " +
        'Example: inputs: { "cityData": "generate-city" } → then use {{cityData.taskOutput.field}} in config templates. ' +
        "Without 'inputs', only 'trigger' and workflow-level 'input' are available for interpolation.\n" +
        "- STRUCTURED OUTPUT: For agent-task nodes, put outputSchema inside 'config' to validate the agent's raw JSON output. " +
        "Node-level outputSchema validates the executor's return ({taskId, taskOutput}), which is different.\n" +
        "- Agent-task config: { template, outputSchema?, agentId?, tags?, priority?, dir?, vcsRepo?, model? }.\n" +
        "- FOREACH NODE: type 'foreach' fans out one agent-task per item. Config: " +
        "{ over: <array or exact {{input}} token>, itemKey: <property name>, body: { type: 'agent-task', config: {...} } }. " +
        "The body config is interpolated once per item with {{item.*}} and {{index}}. Child steps use synthetic IDs " +
        "'<foreachNodeId>#<itemKey>'; the parent waits for every child and exposes one aggregate result to successors. " +
        "concurrency is not supported in v1; use definition-level onNodeFailure: 'continue' to aggregate failed children.\n" +
        "- TRIGGER SCHEMA: Optional 'triggerSchema' is a JSON-Schema object that validates incoming trigger payloads. " +
        "Supported keywords: type, required, properties, enum, const, items (recursive into arrays). " +
        "Other JSON-Schema keywords (oneOf/anyOf/$ref/pattern/format/additionalProperties) are silently ignored.\n" +
        "- WEBHOOK VERIFICATION: Webhook triggers use hmacSecret for all verification formats. " +
        "Omit verification for legacy HMAC-SHA256 over the raw body with fallback header scanning; " +
        "or set verification to { format: 'hmac-sha256', header }, { format: 'timestamped-hmac-sha256', header, toleranceSeconds? }, " +
        "or { format: 'token-equality', header }. Example: { type: 'webhook', hmacSecret: 'secret.SUPERAGENT_WEBHOOK_SECRET', " +
        "verification: { format: 'timestamped-hmac-sha256', header: 'X-Superagent-Signature', toleranceSeconds: 300 } }.\n" +
        "- WAIT NODE: type 'wait' pauses a workflow for a duration or until a named workflowEventBus event arrives. " +
        "See runbooks/workflows.md#wait-nodes for config shapes, ordering caveats, and built-in event names.",
      inputSchema: z.object({
        name: z.string().describe("Unique name for the workflow"),
        key: AssetKeySchema.optional().describe(
          "Logical namespace. Defaults to a shared/workflow:<id>/ resource key.",
        ),
        description: z.string().optional().describe("Description of what this workflow does"),
        definition: WorkflowDefinitionSchema.describe(
          "The workflow definition with nodes (each node has id, type, config, and optional next/retry/validation)",
        ),
        triggers: z
          .array(TriggerConfigSchema)
          .optional()
          .describe(
            "Optional trigger configurations (webhook, schedule). Webhook verification formats: legacy omitted verification, hmac-sha256, timestamped-hmac-sha256, token-equality.",
          ),
        cooldown: CooldownConfigSchema.optional().describe(
          "Optional cooldown configuration to prevent re-triggering too frequently",
        ),
        input: z
          .record(z.string(), InputValueSchema)
          .optional()
          .describe(
            "Optional input values resolved at execution time (env vars like VAR_NAME, secrets secret.NAME, or literals)",
          ),
        dir: z
          .string()
          .min(1)
          .startsWith("/")
          .optional()
          .describe(
            "Default working directory for all agent-task nodes (absolute path, e.g. /tmp/workspace)",
          ),
        vcsRepo: z
          .string()
          .min(1)
          .optional()
          .describe("Default VCS repo for all agent-task nodes (e.g. org/repo)"),
        triggerSchema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Optional JSON-Schema object that validates incoming trigger payloads. " +
              "Supported keywords: type, required, properties, enum, const, items. " +
              "Other JSON-Schema keywords are silently ignored.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        workflow: z.unknown().optional(),
      }),
    },
    async (
      {
        name,
        key,
        description,
        definition,
        triggers,
        cooldown,
        input,
        dir,
        vcsRepo,
        triggerSchema,
      },
      requestInfo,
    ) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID required.");
      }
      try {
        // Validate definition structure
        const validation = validateDefinition(definition, getExecutorRegistry());
        if (!validation.valid) {
          return toolErr(`Invalid definition: ${validation.errors.join("; ")}`);
        }

        const createdBy =
          resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId) ?? undefined;
        const assetKey = key ? authorizeAssetKeyWrite(key, createdBy) : undefined;

        const workflow = createWorkflow(
          {
            key: assetKey,
            name,
            description,
            definition,
            triggers,
            cooldown,
            input,
            dir,
            vcsRepo,
            triggerSchema,
            createdByAgentId: requestInfo.agentId,
            createdBy,
          },
          "mcp",
        );
        const longScriptTimeoutHint = findLongScriptTimeoutHint(definition.nodes);
        return toolOk(`Created workflow "${workflow.name}".`, {
          details: `Created workflow "${workflow.name}" (${workflow.id}).`,
          data: {
            yourAgentId: requestInfo.agentId,
            workflow,
            ...(longScriptTimeoutHint ? { longScriptTimeoutHint } : {}),
          },
        });
      } catch (err) {
        return toolErr(String(err));
      }
    },
  );
};
