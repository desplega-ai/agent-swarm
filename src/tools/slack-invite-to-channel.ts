import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { can } from "@/rbac";
import { getSlackApp } from "@/slack/app";
import { slackMissingScopeMessage } from "@/slack/channel-join";
import { inviteToChannel } from "@/slack/channel-lifecycle";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSlackInviteToChannelTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-invite-to-channel",
    {
      title: "Invite users to a Slack channel",
      description:
        "Invites one or more workspace users to a Slack channel. Users who are already in the channel are treated as a successful no-op. Requires lead privileges.",
      annotations: { openWorldHint: true },

      inputSchema: z.object({
        channelId: z.string().min(1).describe("The Slack channel ID."),
        userIds: z
          .array(z.string().min(1))
          .min(1)
          .max(100)
          .describe("Slack user IDs to invite (up to 100)."),
      }),
      outputSchema: swarmToolOutputSchema({
        channelId: z.string().optional(),
        userIds: z.array(z.string()).optional(),
        alreadyInChannel: z.boolean().optional(),
      }),
    },
    async ({ channelId, userIds }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = await getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr("Agent not found.");
      }

      const decision = can({
        principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
        verb: "integration.slack.channel.invite",
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
        const result = await inviteToChannel(app.client, channelId, userIds);
        return toolOk(
          result.alreadyInChannel
            ? "Users are already in the Slack channel."
            : "Users invited to the Slack channel successfully.",
          {
            data: { channelId, userIds, ...result },
          },
        );
      } catch (error) {
        const missingScopeMessage = slackMissingScopeMessage(error);
        if (missingScopeMessage) {
          return toolErr(`Failed to invite users to Slack channel: ${missingScopeMessage}`);
        }
        const errorMsg = error instanceof Error ? error.message : String(error);
        return toolErr(`Failed to invite users to Slack channel: ${errorMsg}`);
      }
    },
  );
};
