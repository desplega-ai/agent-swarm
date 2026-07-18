import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { deleteSubscription, getSubscriptionByName } from "@/be/subscriptions-db";
import { can } from "@/rbac";
import { createToolRegistrar } from "@/tools/utils";

export const registerDeleteSubscriptionTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "delete-subscription",
    {
      title: "Delete Event Subscription",
      annotations: { destructiveHint: true },
      description: "Delete an event subscription by name. Pending deliveries are not executed.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Subscription name to delete"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async (args, requestInfo) => {
      const fail = (message: string) => ({
        content: [{ type: "text" as const, text: message }],
        structuredContent: { yourAgentId: requestInfo.agentId, success: false, message },
      });

      const callerAgent = requestInfo.agentId ? getAgentById(requestInfo.agentId) : null;
      if (!callerAgent) return fail('Agent not found. Set the "X-Agent-ID" header.');

      const sub = getSubscriptionByName(args.name);
      if (!sub) return fail(`Subscription '${args.name}' not found`);

      // Lead or the creating agent may delete (mirrors task.cancel.any's shape).
      const decision = can({
        principal: { kind: "agent", agentId: callerAgent.id, isLead: callerAgent.isLead },
        verb: "subscription.mutate.any",
        resource: { kind: "owned", ownerAgentId: sub.createdByAgentId ?? null },
        source: "mcp",
      });
      if (!decision.allow) {
        return fail(`Not allowed: ${decision.reason ?? "subscription.mutate.any"}`);
      }
      deleteSubscription(sub.id);
      return {
        content: [{ type: "text", text: `Deleted subscription '${args.name}'` }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Deleted subscription '${args.name}'`,
        },
      };
    },
  );
};
