import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { errorMessage } from "@/integrations/chat-sdk/logger";
import { adapterOfChatId } from "@/integrations/chat-sdk/outbound";
import { getChatInstance } from "@/integrations/chat-sdk/runtime";
import { assertTrustedChatTarget } from "@/integrations/chat-sdk/teams-origin";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { scrubSecrets } from "@/utils/secret-scrubber";

const DEFAULT_LIMIT = 30;

export const registerChatReadThreadTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "chat-read-thread",
    {
      title: "Read recent messages of a chat thread",
      description:
        "Read the most recent messages of a Chat SDK thread, oldest first. Limits per platform: Telegram has no history API, so you get the history the SDK stored in the swarm database, capped at 100 messages and 7 days. Teams needs the Chat.Read.* Graph permission. Slack and Discord return platform history.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        threadId: z
          .string()
          .min(1)
          .describe("Full SDK thread id with the adapter prefix, such as telegram:12345."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(`Number of messages to return (default ${DEFAULT_LIMIT}).`),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        threadId: z.string().optional(),
        messages: z
          .array(
            z.looseObject({
              id: z.string().optional(),
              userId: z.string().optional(),
              userName: z.string().optional(),
              isBot: z.boolean().optional(),
              sentAt: z.string().optional(),
              text: z.string().optional(),
            }),
          )
          .optional(),
      }),
    },
    async ({ threadId, limit }, requestInfo) => {
      const data = { yourAgentId: requestInfo.agentId };
      const adapter = adapterOfChatId(threadId);
      const chat = getChatInstance(adapter);
      if (!chat) return toolErr(`Chat SDK adapter '${adapter}' is not running.`, { data });
      try {
        // Teams reads history with the bot token from the service URL in the id.
        assertTrustedChatTarget(threadId);
        const page = await chat.history.thread.list(threadId, {
          limit: limit ?? DEFAULT_LIMIT,
          direction: "backward",
        });
        const messages = page.messages.map((message) => ({
          id: message.id,
          userId: message.author.userId,
          userName: message.author.userName || message.author.fullName || undefined,
          isBot: message.author.isBot === true,
          sentAt: message.metadata?.dateSent?.toISOString(),
          text: scrubSecrets(message.text ?? ""),
        }));
        const rendered = messages
          .map(
            (m) =>
              `[${m.sentAt ?? "?"}] ${m.userName ?? m.userId}${m.isBot ? " (bot)" : ""}: ${m.text}`,
          )
          .join("\n");
        return toolOk(`${messages.length} message(s) from ${threadId}.`, {
          details: rendered || undefined,
          data: { ...data, threadId, messages },
        });
      } catch (error) {
        const message = errorMessage(error);
        return toolErr(`Could not read the thread: ${message}`, { data });
      }
    },
  );
};
