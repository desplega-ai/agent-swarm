import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getSlackApp } from "@/slack/app";
import { createToolRegistrar } from "@/tools/utils";

const SlackChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["public", "private", "dm", "mpim"]),
  isMember: z.boolean(),
  numMembers: z.number().optional(),
});

export const registerSlackListChannelsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-list-channels",
    {
      title: "List Slack channels",
      description:
        "List Slack channels the bot is a member of. Use this to discover available channels for reading messages.",
      inputSchema: z.object({
        types: z
          .array(z.enum(["public", "private", "dm", "mpim"]))
          .optional()
          .describe(
            "Filter by channel types. Options: public (public channels), private (private channels), dm (direct messages), mpim (group DMs). Default: all types.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(100)
          .describe("Maximum number of channels to retrieve (default: 100, max: 200)."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        channels: z.array(SlackChannelSchema),
      }),
    },
    async ({ types, limit = 100 }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found.", channels: [] },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent) {
        return {
          content: [{ type: "text", text: "Agent not found." }],
          structuredContent: { success: false, message: "Agent not found.", channels: [] },
        };
      }

      const app = getSlackApp();
      if (!app) {
        return {
          content: [{ type: "text", text: "Slack not configured." }],
          structuredContent: { success: false, message: "Slack not configured.", channels: [] },
        };
      }

      try {
        const client = app.client;

        // Map our types to Slack API types
        const typeMapping: Record<string, string> = {
          public: "public_channel",
          private: "private_channel",
          dm: "im",
          mpim: "mpim",
        };

        // Build types string for Slack API
        const slackTypes = types
          ? types.map((t) => typeMapping[t]).join(",")
          : "public_channel,private_channel,im,mpim";

        const result = await client.conversations.list({
          types: slackTypes,
          limit,
          exclude_archived: true,
        });

        const channels: Array<{
          id: string;
          name: string;
          type: "public" | "private" | "dm" | "mpim";
          isMember: boolean;
          numMembers?: number;
        }> = [];

        for (const channel of result.channels || []) {
          if (!channel.id) continue;

          // Determine channel type
          let channelType: "public" | "private" | "dm" | "mpim";
          if (channel.is_im) {
            channelType = "dm";
          } else if (channel.is_mpim) {
            channelType = "mpim";
          } else if (channel.is_private) {
            channelType = "private";
          } else {
            channelType = "public";
          }

          // Get channel name (DMs don't have names, use user ID)
          let name = channel.name || "";
          if (channel.is_im && channel.user) {
            // Try to get user name for DMs
            try {
              const userInfo = await client.users.info({ user: channel.user });
              name =
                userInfo.user?.profile?.display_name || userInfo.user?.real_name || channel.user;
            } catch {
              name = channel.user;
            }
          }

          channels.push({
            id: channel.id,
            name,
            type: channelType,
            isMember: channel.is_member ?? true,
            numMembers: channel.num_members,
          });
        }

        // Format text output
        const textOutput = channels
          .map((c) => {
            const memberInfo = c.numMembers ? ` (${c.numMembers} members)` : "";
            return `- ${c.name} [${c.type}] - ID: ${c.id}${memberInfo}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${channels.length} channel(s):\n\n${textOutput}`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Found ${channels.length} channel(s).`,
            channels,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to list Slack channels: ${errorMsg}` }],
          structuredContent: {
            success: false,
            message: `Failed to list Slack channels: ${errorMsg}`,
            channels: [],
          },
        };
      }
    },
  );
};
