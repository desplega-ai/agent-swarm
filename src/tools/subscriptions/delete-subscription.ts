import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteSubscription, getSubscriptionByName } from "@/be/subscriptions-db";
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
