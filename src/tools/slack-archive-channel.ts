import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { can } from "@/rbac";
import { getSlackApp } from "@/slack/app";
import { slackMissingScopeMessage } from "@/slack/channel-join";
import { archiveChannel } from "@/slack/channel-lifecycle";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSlackArchiveChannelTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-archive-channel",
    {
      title: "Archive a Slack channel",
      description:
        "Archives a Slack channel. Channels that are already archived are treated as a successful no-op, while Slack's general channel cannot be archived. Requires lead privileges.",
      annotations: { openWorldHint: true, destructiveHint: true },

      inputSchema: z.object({
        channelId: z.string().min(1).describe("The Slack channel ID to archive."),
      }),
      outputSchema: swarmToolOutputSchema({
        channelId: z.string().optional(),
        alreadyArchived: z.boolean().optional(),
      }),
    },
    async ({ channelId }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = await getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr("Agent not found.");
      }

      const decision = can({
        principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
        verb: "integration.slack.channel.archive",
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
        const result = await archiveChannel(app.client, channelId);
        return toolOk(
          result.alreadyArchived
            ? "Slack channel is already archived."
            : "Slack channel archived successfully.",
          { data: { channelId, ...result } },
        );
      } catch (error) {
        const missingScopeMessage = slackMissingScopeMessage(error);
        if (missingScopeMessage) {
          return toolErr(`Failed to archive Slack channel: ${missingScopeMessage}`);
        }
        const errorMsg = error instanceof Error ? error.message : String(error);
        return toolErr(`Failed to archive Slack channel: ${errorMsg}`);
      }
    },
  );
};
