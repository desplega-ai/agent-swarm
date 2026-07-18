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
      const callerAgent = requestInfo.agentId ? getAgentById(requestInfo.agentId) : null;
      const decision = callerAgent
        ? can({
            principal: { kind: "agent", agentId: callerAgent.id, isLead: callerAgent.isLead },
            verb: "subscription.write",
            source: "mcp",
          })
        : { allow: false as const, reason: "agent not found" };
      if (!decision.allow) {
        const message = `Not allowed: ${"reason" in decision ? decision.reason : "subscription.write"}`;
        return {
          content: [{ type: "text", text: message }],
          structuredContent: { yourAgentId: requestInfo.agentId, success: false, message },
        };
      }

      const sub = getSubscriptionByName(args.name);
      if (!sub) {
        return {
          content: [{ type: "text", text: `Subscription '${args.name}' not found` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Subscription '${args.name}' not found`,
          },
        };
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
