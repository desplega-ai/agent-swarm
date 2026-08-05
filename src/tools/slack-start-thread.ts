import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getTaskById, recordSlackMessage } from "@/be/db";
import { can } from "@/rbac";
import { getSlackApp } from "@/slack/app";
import { withAutoJoin } from "@/slack/channel-join";
import { getAgentDisplayName, getAgentEmoji, markdownToSlack } from "@/slack/responses";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSlackStartThreadTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-start-thread",
    {
      title: "Start a new Slack thread",
      description:
        "Post a new top-level message to a Slack channel and return its ts so the caller can thread replies under it. Pass the returned `ts` as `threadTs` on subsequent `slack-post` calls to keep replies in the same thread. Requires lead privileges.",
      annotations: { openWorldHint: true },

      inputSchema: z.object({
        channelId: z.string().min(1).describe("The Slack channel ID to post to."),
        message: z.string().min(1).max(4000).describe("The message content to post."),
        blocks: z
          .array(z.record(z.string(), z.unknown()))
          .max(50)
          .optional()
          .describe("Optional Block Kit blocks. When omitted, a mrkdwn section is generated."),
      }),
      outputSchema: swarmToolOutputSchema({
        channelId: z.string().optional(),
        ts: z.string().optional(),
        messageTs: z.string().optional(),
      }),
    },
    async ({ channelId, message, blocks }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr("Agent not found.");
      }

      const decision = can({
        principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
        verb: "integration.slack.thread.start",
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
        const messageBlocks = blocks ?? [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: slackMessage,
            },
          },
        ];

        const result = await withAutoJoin(app.client, channelId, () =>
          app.client.chat.postMessage({
            channel: channelId,
            text: slackMessage, // Fallback for notifications
            unfurl_links: false,
            unfurl_media: false,
            username: getAgentDisplayName(agent),
            icon_emoji: getAgentEmoji(agent),
            // biome-ignore lint/suspicious/noExplicitAny: MCP accepts arbitrary valid Block Kit JSON
            blocks: messageBlocks as any,
          }),
        );

        const ts = result.ts;
        const resolvedChannelId = result.channel ?? channelId;

        if (!ts) {
          return toolErr("Message posted but Slack did not return a ts — cannot thread replies.", {
            data: { channelId: resolvedChannelId },
          });
        }

        const sourceTask = requestInfo.sourceTaskId
          ? getTaskById(requestInfo.sourceTaskId)
          : undefined;
        recordSlackMessage({
          contextKey: sourceTask?.contextKey ?? `task:slack:${resolvedChannelId}:${ts}`,
          channelId: resolvedChannelId,
          threadTs: ts,
          ts,
          kind: "agent",
          taskId: sourceTask?.id,
          finalized: true,
          actorId: agent.id,
        });

        return toolOk("Thread started successfully.", {
          details: `Thread started. channelId=${resolvedChannelId}, ts=${ts}. Pass ts as threadTs on slack-post to reply in-thread.`,
          data: { channelId: resolvedChannelId, ts, messageTs: ts },
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return toolErr(`Failed to start thread: ${errorMsg}`);
      }
    },
  );
};
