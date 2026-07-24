import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import { getAgentById, getWorkflow } from "@/be/db";
import { getScript } from "@/be/scripts/db";
import { createSubscription, getSubscriptionByName } from "@/be/subscriptions-db";
import { can } from "@/rbac";
import { validateEventPattern } from "@/subscriptions/matcher";
import { SubscriptionSchema, SubscriptionTargetTypeSchema } from "@/subscriptions/types";
import { createToolRegistrar } from "@/tools/utils";

export const createSubscriptionInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .describe("Unique name for the subscription (e.g., 'triage-failed-tasks')"),
  description: z.string().optional().describe("Human-readable description"),
  eventPattern: z
    .string()
    .min(1)
    .describe(
      "Glob over dot-separated event names: '*' matches one segment, '**' (last segment only) " +
        "matches the rest. Examples: 'task.completed', 'task.*', 'github.**'.",
    ),
  filter: z
    .union([z.record(z.string(), z.unknown()), z.string()])
    .optional()
    .describe(
      "Optional payload filter (wait-node filter language): object of dot-path → expected value " +
        "for deep-equal matching, or a string expression over the event payload.",
    ),
  targetType: SubscriptionTargetTypeSchema.describe(
    "What to run when the event fires: 'script' (global catalog script, receives the event as " +
      "args.event) or 'workflow' (triggered with { event, subscriptionId } as trigger data).",
  ),
  scriptName: z
    .string()
    .optional()
    .describe("Catalog script name (global scope). Required when targetType is 'script'."),
  scriptArgs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Extra JSON args merged into the script invocation (event wins on key 'event')."),
  workflowId: z
    .string()
    .uuid()
    .optional()
    .describe("Workflow ID to trigger. Required when targetType is 'workflow'."),
  enabled: z.boolean().default(true).optional(),
});

export const registerCreateSubscriptionTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "create-subscription",
    {
      title: "Create Event Subscription",
      annotations: { destructiveHint: false },
      description:
        "Subscribe a catalog script or workflow to swarm events (task lifecycle, GitHub/GitLab " +
        "webhooks, approvals, …). When a matching event fires, the target runs with the event " +
        "payload. Delivery is at-least-once with retries.",
      inputSchema: createSubscriptionInputSchema,
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        subscription: SubscriptionSchema.optional(),
      }),
    },
    async (args, requestInfo) => {
      try {
        const callerAgent = requestInfo.agentId ? getAgentById(requestInfo.agentId) : null;
        if (!callerAgent) throw new Error('Agent not found. Set the "X-Agent-ID" header.');
        const decision = can({
          principal: { kind: "agent", agentId: callerAgent.id, isLead: callerAgent.isLead },
          verb: "subscription.write",
          source: "mcp",
        });
        if (!decision.allow) {
          throw new Error(`Not allowed: ${decision.reason ?? "subscription.write"}`);
        }

        const patternError = validateEventPattern(args.eventPattern);
        if (patternError) throw new Error(patternError);
        if (args.targetType === "script") {
          if (!args.scriptName) throw new Error("scriptName is required when targetType=script");
          if (!getScript({ name: args.scriptName, scope: "global" })) {
            throw new Error(`Script '${args.scriptName}' not found in global scope`);
          }
        }
        if (args.targetType === "workflow") {
          if (!args.workflowId) throw new Error("workflowId is required when targetType=workflow");
          if (!getWorkflow(args.workflowId)) {
            throw new Error(`Workflow ${args.workflowId} not found`);
          }
        }
        if (getSubscriptionByName(args.name)) {
          throw new Error(`Subscription '${args.name}' already exists`);
        }

        const subscription = createSubscription({
          name: args.name,
          description: args.description,
          eventPattern: args.eventPattern,
          filter: args.filter,
          targetType: args.targetType,
          scriptName: args.scriptName,
          scriptArgs: args.scriptArgs,
          workflowId: args.workflowId,
          enabled: args.enabled,
          createdByAgentId: requestInfo.agentId,
          createdBy:
            resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId) ?? undefined,
        });

        return {
          content: [
            {
              type: "text",
              text: `Created subscription "${args.name}" (${args.eventPattern} → ${args.targetType}).`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Created subscription "${args.name}".`,
            subscription,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to create subscription: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to create subscription: ${message}`,
          },
        };
      }
    },
  );
};
