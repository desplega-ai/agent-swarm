import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getInboxMessageById, getTaskById } from "@/be/db";
import { getSlackApp } from "@/slack/app";
import { createToolRegistrar } from "@/tools/utils";

const SlackMessageSchema = z.object({
  user: z.string().optional(),
  username: z.string().optional(),
  isBot: z.boolean(),
  text: z.string(),
  ts: z.string(),
});

export const registerSlackReadTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-read",
    {
      title: "Read Slack thread/channel history",
      description:
        "Read messages from a Slack thread or channel. Use inboxMessageId or taskId to read from a thread you have context for, or provide channelId directly for channel history (leads only).",
      inputSchema: z.object({
        inboxMessageId: z.uuid().optional().describe("Read thread history for an inbox message."),
        taskId: z.uuid().optional().describe("Read thread history for a task."),
        channelId: z
          .string()
          .optional()
          .describe("Slack channel ID to read from (requires lead privileges)."),
        threadTs: z
          .string()
          .optional()
          .describe("Thread timestamp (required with channelId for thread history)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Maximum number of messages to retrieve (default: 20, max: 100)."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        channelId: z.string().optional(),
        threadTs: z.string().optional(),
        messages: z.array(SlackMessageSchema),
      }),
    },
    async ({ inboxMessageId, taskId, channelId, threadTs, limit = 20 }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found.", messages: [] },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent) {
        return {
          content: [{ type: "text", text: "Agent not found." }],
          structuredContent: { success: false, message: "Agent not found.", messages: [] },
        };
      }

      let slackChannelId: string | undefined = channelId;
      let slackThreadTs: string | undefined = threadTs;

      // Determine Slack context from inbox message or task
      if (inboxMessageId) {
        const inboxMsg = getInboxMessageById(inboxMessageId);
        if (!inboxMsg) {
          return {
            content: [{ type: "text", text: "Inbox message not found." }],
            structuredContent: {
              success: false,
              message: "Inbox message not found.",
              messages: [],
            },
          };
        }
        if (inboxMsg.agentId !== requestInfo.agentId) {
          return {
            content: [{ type: "text", text: "This inbox message is not yours." }],
            structuredContent: {
              success: false,
              message: "This inbox message is not yours.",
              messages: [],
            },
          };
        }
        slackChannelId = inboxMsg.slackChannelId;
        slackThreadTs = inboxMsg.slackThreadTs;
      } else if (taskId) {
        const task = getTaskById(taskId);
        if (!task) {
          return {
            content: [{ type: "text", text: "Task not found." }],
            structuredContent: { success: false, message: "Task not found.", messages: [] },
          };
        }
        // Verify agent has context for this task
        if (task.agentId !== requestInfo.agentId && task.creatorAgentId !== requestInfo.agentId) {
          return {
            content: [{ type: "text", text: "You don't have context for this task." }],
            structuredContent: {
              success: false,
              message: "You don't have context for this task.",
              messages: [],
            },
          };
        }
        slackChannelId = task.slackChannelId;
        slackThreadTs = task.slackThreadTs;
      } else if (channelId) {
        // Direct channel access requires lead privileges
        if (!agent.isLead) {
          return {
            content: [{ type: "text", text: "Direct channel access requires lead privileges." }],
            structuredContent: {
              success: false,
              message: "Direct channel access requires lead privileges.",
              messages: [],
            },
          };
        }
        slackChannelId = channelId;
        slackThreadTs = threadTs;
      } else {
        return {
          content: [{ type: "text", text: "Must provide inboxMessageId, taskId, or channelId." }],
          structuredContent: {
            success: false,
            message: "Must provide inboxMessageId, taskId, or channelId.",
            messages: [],
          },
        };
      }

      if (!slackChannelId) {
        return {
          content: [{ type: "text", text: "No Slack channel context available." }],
          structuredContent: {
            success: false,
            message: "No Slack channel context available.",
            messages: [],
          },
        };
      }

      const app = getSlackApp();
      if (!app) {
        return {
          content: [{ type: "text", text: "Slack not configured." }],
          structuredContent: { success: false, message: "Slack not configured.", messages: [] },
        };
      }

      try {
        const client = app.client;

        type RawMessage = {
          user?: string;
          bot_id?: string;
          username?: string;
          subtype?: string;
          text?: string;
          ts: string;
        };

        let rawMessages: RawMessage[] = [];

        if (slackThreadTs) {
          // Fetch thread replies
          const result = await client.conversations.replies({
            channel: slackChannelId,
            ts: slackThreadTs,
            limit,
          });
          rawMessages = (result.messages || []) as RawMessage[];
        } else {
          // Fetch channel history
          const result = await client.conversations.history({
            channel: slackChannelId,
            limit,
          });
          rawMessages = (result.messages || []) as RawMessage[];
        }

        // Get bot user ID for identification
        const authResult = await client.auth.test();
        const botUserId = authResult.user_id as string;

        // Cache for user display names
        const userNameCache = new Map<string, string>();

        async function getUserDisplayName(userId: string): Promise<string> {
          if (userNameCache.has(userId)) {
            return userNameCache.get(userId)!;
          }
          try {
            const result = await client.users.info({ user: userId });
            const name = result.user?.profile?.display_name || result.user?.real_name || userId;
            userNameCache.set(userId, name);
            return name;
          } catch {
            return userId;
          }
        }

        // Format messages
        const messages: Array<{
          user: string | undefined;
          username: string | undefined;
          isBot: boolean;
          text: string;
          ts: string;
        }> = [];

        for (const m of rawMessages) {
          if (!m.text) continue;

          const isBot =
            m.user === botUserId || m.bot_id !== undefined || m.subtype === "bot_message";
          let username: string | undefined;

          if (isBot) {
            username = m.username || "Agent";
          } else if (m.user) {
            username = await getUserDisplayName(m.user);
          }

          messages.push({
            user: m.user,
            username,
            isBot,
            text: m.text,
            ts: m.ts,
          });
        }

        // Format for text output
        const textOutput = messages
          .map((m) => `[${m.username || m.user || "Unknown"}]: ${m.text}`)
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Retrieved ${messages.length} message(s) from Slack.\n\n${textOutput}`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Retrieved ${messages.length} message(s).`,
            channelId: slackChannelId,
            threadTs: slackThreadTs,
            messages,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to read Slack messages: ${errorMsg}` }],
          structuredContent: {
            success: false,
            message: `Failed to read Slack messages: ${errorMsg}`,
            messages: [],
          },
        };
      }
    },
  );
};
