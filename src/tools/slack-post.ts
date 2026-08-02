import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  getAgentById,
  getSlackTreeMessageByThread,
  getTaskById,
  recordSlackMessage,
} from "@/be/db";
import { can } from "@/rbac";
import { getSlackApp } from "@/slack/app";
import { getTaskLink } from "@/slack/blocks";
import { withAutoJoin } from "@/slack/channel-join";
import { markdownToSlack } from "@/slack/responses";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSlackPostTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-post",
    {
      title: "Post message to Slack channel",
      description:
        "Post a message to a Slack channel. By default creates a new top-level message; pass `threadTs` to post as a threaded reply under an existing message (obtain the ts from `slack-start-thread`). Requires lead privileges.",
      annotations: { openWorldHint: true },

      inputSchema: z.object({
        channelId: z.string().min(1).describe("The Slack channel ID to post to."),
        message: z.string().min(1).max(4000).describe("The message content to post."),
        blocks: z
          .array(z.record(z.string(), z.unknown()))
          .max(50)
          .optional()
          .describe("Optional Block Kit blocks. When omitted, a mrkdwn section is generated."),
        threadTs: z
          .string()
          .optional()
          .describe(
            "Optional parent message ts to thread under. Obtain via `slack-start-thread`. When omitted, posts as a new top-level message.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        messageTs: z.string().optional(),
      }),
    },
    async ({ channelId, message, threadTs, blocks }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr("Agent not found.");
      }

      // Require lead privileges to post directly to channels
      const decision = can({
        principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
        verb: "integration.slack.post",
        resource: { kind: "none" },
        source: "mcp",
      });
      if (!decision.allow) {
        return toolErr("Posting to Slack channels requires lead privileges.");
      }

      const app = getSlackApp();
      if (!app) {
        return toolErr("Slack not configured.");
      }

      try {
        const slackMessage = markdownToSlack(message);

        const sourceTask = requestInfo.sourceTaskId
          ? getTaskById(requestInfo.sourceTaskId)
          : undefined;
        const contextKey = sourceTask?.contextKey;
        const tree = threadTs ? getSlackTreeMessageByThread(channelId, threadTs) : null;
        const messageBlocks: Record<string, unknown>[] = [
          ...(blocks ?? [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: slackMessage,
              },
            },
          ]),
        ];
        if (sourceTask && tree) {
          if (messageBlocks.length >= 50) {
            return toolErr("At most 49 blocks are allowed when a provenance footer is added.");
          }
          messageBlocks.push({
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `${agent.name} · ${getTaskLink(sourceTask.id)}`,
              },
            ],
          });
        }

        const result = await withAutoJoin(app.client, channelId, () =>
          app.client.chat.postMessage({
            channel: channelId,
            text: slackMessage, // Fallback for notifications
            unfurl_links: false,
            unfurl_media: false,
            username: agent.name,
            icon_emoji: ":crown:",
            ...(threadTs ? { thread_ts: threadTs } : {}),
            // biome-ignore lint/suspicious/noExplicitAny: MCP accepts arbitrary valid Block Kit JSON
            blocks: messageBlocks as any,
          }),
        );

        const messageTs = result.ts;
        if (messageTs) {
          const effectiveThreadTs = threadTs ?? messageTs;
          recordSlackMessage({
            contextKey: contextKey ?? `task:slack:${channelId}:${effectiveThreadTs}`,
            channelId,
            threadTs: effectiveThreadTs,
            ts: messageTs,
            kind: "agent",
            taskId: sourceTask?.id,
            finalized: true,
            actorId: agent.id,
          });
        }

        return toolOk("Message posted successfully.", {
          details: messageTs ? `Message timestamp: ${messageTs}` : undefined,
          data: { messageTs },
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return toolErr(`Failed to post message: ${errorMsg}`);
      }
    },
  );
};
