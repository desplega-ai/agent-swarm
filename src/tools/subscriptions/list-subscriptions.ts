import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { listDeliveriesForSubscription, listSubscriptions } from "@/be/subscriptions-db";
import { SubscriptionDeliverySchema, SubscriptionSchema } from "@/subscriptions/types";
import { createToolRegistrar } from "@/tools/utils";

export const registerListSubscriptionsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-subscriptions",
    {
      title: "List Event Subscriptions",
      annotations: { readOnlyHint: true },
      description:
        "List event subscriptions (event pattern → script/workflow bindings), optionally with " +
        "recent delivery attempts per subscription.",
      inputSchema: z.object({
        enabledOnly: z.boolean().default(false).optional(),
        includeDeliveries: z
          .boolean()
          .default(false)
          .optional()
          .describe("Include the 5 most recent deliveries per subscription"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        subscriptions: z.array(
          SubscriptionSchema.extend({
            recentDeliveries: z.array(SubscriptionDeliverySchema).optional(),
          }),
        ),
      }),
    },
    async (args, requestInfo) => {
      const subscriptions = listSubscriptions({ enabledOnly: args.enabledOnly }).map((sub) =>
        args.includeDeliveries
          ? { ...sub, recentDeliveries: listDeliveriesForSubscription(sub.id, 5) }
          : sub,
      );
      return {
        content: [
          {
            type: "text",
            text:
              subscriptions.length === 0
                ? "No subscriptions."
                : subscriptions
                    .map(
                      (s) =>
                        `${s.enabled ? "●" : "○"} ${s.name}: ${s.eventPattern} → ` +
                        `${s.targetType === "script" ? `script:${s.scriptName}` : `workflow:${s.workflowId}`}`,
                    )
                    .join("\n"),
          },
        ],
        structuredContent: { yourAgentId: requestInfo.agentId, subscriptions },
      };
    },
  );
};
