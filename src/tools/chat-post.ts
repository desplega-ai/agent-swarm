import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { CHAT_SDK_ADAPTER_NAMES } from "@/integrations/chat-sdk/config";
import { errorMessage } from "@/integrations/chat-sdk/logger";
import { adapterOfChatId, postChatMessage } from "@/integrations/chat-sdk/outbound";
import { canUseChatVerb } from "@/tools/chat-access";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerChatPostTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "chat-post",
    {
      title: "Post to a chat thread or channel",
      description:
        "Lead only. Post a message to any Chat SDK thread or channel (Telegram, Slack, Discord, Teams), outside the thread of your current task. Give threadId to reply in a thread, or channelId to start a new message in a channel. Ids carry the adapter prefix, such as telegram:12345. To answer the user of your current chat task, use chat-reply instead.",
      annotations: { openWorldHint: true },
      inputSchema: z.object({
        adapter: z.enum(CHAT_SDK_ADAPTER_NAMES).describe("Chat SDK adapter name."),
        threadId: z
          .string()
          .min(1)
          .optional()
          .describe("Full SDK thread id, such as telegram:12345 or slack:C123:1700000000.000100."),
        channelId: z
          .string()
          .min(1)
          .optional()
          .describe("Full SDK channel id, such as slack:C123. Ignored when threadId is set."),
        text: z.string().min(1).max(20_000).describe("Markdown text to post."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        messageId: z.string().optional(),
        adapter: z.string().optional(),
        threadId: z.string().optional(),
        channelId: z.string().optional(),
      }),
    },
    async ({ adapter, threadId, channelId, text }, requestInfo) => {
      const data = { yourAgentId: requestInfo.agentId };
      const target = threadId ?? channelId;
      if (!target) return toolErr("Give a threadId or a channelId.", { data });
      if (adapterOfChatId(target) !== adapter) {
        return toolErr(`The id ${target} does not belong to the ${adapter} adapter.`, { data });
      }
      if (!(await canUseChatVerb(requestInfo, "integration.chat.post"))) {
        return toolErr(
          "Permission denied. Only the lead can post outside the thread of its task. Use chat-reply for the thread of your current task.",
          { data },
        );
      }
      try {
        const sent = await postChatMessage({
          adapter,
          ...(threadId ? { threadId } : { channelId }),
          text,
          taskId: requestInfo.sourceTaskId,
        });
        return toolOk(`Posted to ${adapter} ${threadId ? "thread" : "channel"} ${target}.`, {
          data: {
            ...data,
            messageId: sent.messageIds.at(-1),
            adapter: sent.adapter,
            threadId: sent.threadId,
            channelId: sent.channelId,
          },
        });
      } catch (error) {
        const message = errorMessage(error);
        return toolErr(`Could not post: ${message}`, { data });
      }
    },
  );
};
