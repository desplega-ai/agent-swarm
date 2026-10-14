import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { CHAT_SDK_ADAPTER_NAMES } from "@/integrations/chat-sdk/config";
import { errorMessage } from "@/integrations/chat-sdk/logger";
import { getChatInstance } from "@/integrations/chat-sdk/runtime";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerChatOpenDmTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "chat-open-dm",
    {
      title: "Open a direct message on a chat platform",
      description:
        "Open (or find) the direct-message thread with a user on a Chat SDK adapter and return its threadId. Post to it with chat-post. The userId is the platform user id from a chat message (Telegram numeric id, Slack U..., Discord snowflake, Teams 29:...). Telegram bots can message only users who started a chat with the bot.",
      annotations: { openWorldHint: true },
      inputSchema: z.object({
        adapter: z.enum(CHAT_SDK_ADAPTER_NAMES).describe("Chat SDK adapter name."),
        userId: z.string().min(1).describe("Platform user id."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        adapter: z.string().optional(),
        threadId: z.string().optional(),
      }),
    },
    async ({ adapter, userId }, requestInfo) => {
      const data = { yourAgentId: requestInfo.agentId };
      const chat = getChatInstance(adapter);
      if (!chat) return toolErr(`Chat SDK adapter '${adapter}' is not running.`, { data });
      // Call the adapter directly: Chat.openDM guesses the adapter from the
      // user id format, and numeric ids are ambiguous.
      const platform = chat.getAdapter(adapter);
      if (!platform?.openDM) {
        return toolErr(`The ${adapter} adapter does not support direct messages.`, { data });
      }
      try {
        const threadId = await platform.openDM(userId);
        return toolOk(`Direct-message thread with ${userId} on ${adapter}: ${threadId}.`, {
          data: { ...data, adapter, threadId },
        });
      } catch (error) {
        const message = errorMessage(error);
        return toolErr(`Could not open a direct message: ${message}`, { data });
      }
    },
  );
};
