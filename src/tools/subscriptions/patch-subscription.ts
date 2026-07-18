import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import { getAgentById } from "@/be/db";
import { getSubscriptionByName, updateSubscription } from "@/be/subscriptions-db";
import { can } from "@/rbac";
import { validateEventPattern } from "@/subscriptions/matcher";
import { SubscriptionSchema } from "@/subscriptions/types";
import { createToolRegistrar } from "@/tools/utils";

export const registerPatchSubscriptionTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "patch-subscription",
    {
      title: "Patch Event Subscription",
      annotations: { destructiveHint: false },
      description:
        "Update fields of an event subscription: pause/resume (enabled), description, " +
        "eventPattern, filter, or scriptArgs. Target (script/workflow) is immutable — " +
        "delete and recreate to retarget.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Subscription name to patch"),
        description: z.string().optional(),
        eventPattern: z.string().min(1).optional(),
        filter: z
          .union([z.record(z.string(), z.unknown()), z.string(), z.null()])
          .optional()
          .describe("New payload filter; pass null to clear"),
        scriptArgs: z
          .union([z.record(z.string(), z.unknown()), z.null()])
          .optional()
          .describe("New extra script args; pass null to clear"),
        enabled: z.boolean().optional().describe("false pauses the subscription"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        subscription: SubscriptionSchema.optional(),
      }),
    },
    async (args, requestInfo) => {
      const fail = (message: string) => ({
        content: [{ type: "text" as const, text: message }],
        structuredContent: { yourAgentId: requestInfo.agentId, success: false, message },
      });

      const callerAgent = requestInfo.agentId ? getAgentById(requestInfo.agentId) : null;
      if (!callerAgent) return fail('Agent not found. Set the "X-Agent-ID" header.');
      const decision = can({
        principal: { kind: "agent", agentId: callerAgent.id, isLead: callerAgent.isLead },
        verb: "subscription.write",
        source: "mcp",
      });
      if (!decision.allow) return fail(`Not allowed: ${decision.reason ?? "subscription.write"}`);

      const sub = getSubscriptionByName(args.name);
      if (!sub) return fail(`Subscription '${args.name}' not found`);
      if (args.eventPattern !== undefined) {
        const patternError = validateEventPattern(args.eventPattern);
        if (patternError) return fail(patternError);
      }

      const updated = updateSubscription(sub.id, {
        description: args.description,
        eventPattern: args.eventPattern,
        filter: args.filter,
        scriptArgs: args.scriptArgs,
        enabled: args.enabled,
        updatedBy:
          resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId) ?? undefined,
      });
      return {
        content: [{ type: "text", text: `Updated subscription '${args.name}'.` }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Updated subscription '${args.name}'.`,
          subscription: updated ?? undefined,
        },
      };
    },
  );
};
