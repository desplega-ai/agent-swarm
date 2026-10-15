import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { CHAT_SDK_ADAPTER_NAMES } from "@/integrations/chat-sdk/config";
import { errorMessage } from "@/integrations/chat-sdk/logger";
import { getChatInstance } from "@/integrations/chat-sdk/runtime";
import { assertTrustedTeamsServiceUrl } from "@/integrations/chat-sdk/teams-origin";
import { canUseChatVerb } from "@/tools/chat-access";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerChatOpenDmTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "chat-open-dm",
    {
      title: "Open a direct message on a chat platform",
      description:
        "Lead only. Open (or find) the direct-message thread with a user on a Chat SDK adapter and return its threadId. Post to it with chat-post. The userId is the platform user id from a chat message (Telegram numeric id, Slack U..., Discord snowflake, Teams 29:...). Telegram bots can message only users who started a chat with the bot.",
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
      if (!(await canUseChatVerb(requestInfo, "integration.chat.dm"))) {
        return toolErr("Permission denied. Only the lead can open a direct message.", { data });
      }
      const chat = getChatInstance(adapter);
      if (!chat) return toolErr(`Chat SDK adapter '${adapter}' is not running.`, { data });
      // Call the adapter directly: Chat.openDM guesses the adapter from the
      // user id format, and numeric ids are ambiguous.
      const platform = chat.getAdapter(adapter);
      if (!platform?.openDM) {
        return toolErr(`The ${adapter} adapter does not support direct messages.`, { data });
      }
      try {
        if (adapter === "teams") {
          // Teams opens the DM at the service URL cached from the user's last
          // activity (adapter state key). The webhook route refuses untrusted
          // ones; check again before the bot token goes out.
          const cached = await chat.getState().get<string>(`teams:serviceUrl:${userId}`);
          if (cached) assertTrustedTeamsServiceUrl(cached);
        }
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
