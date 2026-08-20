import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { can } from "@/rbac";
import { getSlackApp } from "@/slack/app";
import { slackMissingScopeMessage } from "@/slack/channel-join";
import { createChannel } from "@/slack/channel-lifecycle";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSlackCreateChannelTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-create-channel",
    {
      title: "Create a Slack channel",
      description:
        "Creates a public or private Slack channel. The supplied name is normalized to Slack's channel-name rules, and the normalized name is returned. Requires lead privileges.",
      annotations: { openWorldHint: true },

      inputSchema: z.object({
        name: z.string().min(1).describe("The desired Slack channel name."),
        isPrivate: z
          .boolean()
          .optional()
          .default(false)
          .describe("Whether to create a private channel. Defaults to false."),
      }),
      outputSchema: swarmToolOutputSchema({
        channelId: z.string().optional(),
        name: z.string().optional(),
        isPrivate: z.boolean().optional(),
      }),
    },
    async ({ name, isPrivate }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr("Agent not found.");
      }

      const decision = can({
        principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
        verb: "integration.slack.channel.create",
        resource: { kind: "none" },
        source: "mcp",
      });
      if (!decision.allow) {
        return toolErr("Managing Slack channels requires lead privileges.");
      }

      const app = getSlackApp();
      if (!app) {
        return toolErr("Slack not configured.");
      }

      try {
        const result = await createChannel(app.client, { name, isPrivate });
        return toolOk("Slack channel created successfully.", {
          details: `Created Slack channel ${result.name} (${result.channelId}).`,
          data: { ...result, isPrivate },
        });
      } catch (error) {
        const missingScopeMessage = slackMissingScopeMessage(error);
        if (missingScopeMessage) {
          return toolErr(`Failed to create Slack channel: ${missingScopeMessage}`);
        }
        const errorMsg = error instanceof Error ? error.message : String(error);
        return toolErr(`Failed to create Slack channel: ${errorMsg}`);
      }
    },
  );
};
