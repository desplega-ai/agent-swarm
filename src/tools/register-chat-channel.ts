import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getWorkflow } from "@/be/db";
import { CHAT_SDK_ADAPTER_NAMES } from "@/integrations/chat-sdk/config";
import { errorMessage } from "@/integrations/chat-sdk/logger";
import {
  type ChatChannelMapping,
  chatChannelKey,
  deleteChatChannelMapping,
  putChatChannelMapping,
} from "@/integrations/chat-sdk/router";
import { can } from "@/rbac";
import {
  createToolRegistrar,
  type RequestInfo,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "@/tools/utils";

async function canManageChatChannels(requestInfo: RequestInfo): Promise<boolean> {
  const caller = requestInfo.agentId ? await getAgentById(requestInfo.agentId) : null;
  return can({
    principal: {
      kind: "agent",
      agentId: requestInfo.agentId ?? "",
      isLead: caller?.isLead ?? false,
    },
    verb: "integration.chat.manage",
    resource: { kind: "none" },
    source: "mcp",
  }).allow;
}

export const registerRegisterChatChannelTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "register-chat-channel",
    {
      title: "Route a chat channel to an agent or workflow",
      annotations: { idempotentHint: true },
      description:
        "Lead-only. Route every swarm-addressed message from one Chat SDK channel (a Telegram group, Slack channel, Discord channel or Teams chat) to a fixed agent or workflow instead of the lead. Give exactly one of agentId or workflowId. A swarm#<agentId> token in a message still wins over the mapping. Remove it with unregister-chat-channel.",
      inputSchema: z.object({
        adapter: z.enum(CHAT_SDK_ADAPTER_NAMES).describe("Chat SDK adapter name."),
        channelId: z
          .string()
          .min(1)
          .describe("SDK channel id, such as telegram:-100123 or slack:C123 (prefix optional)."),
        agentId: z.string().optional().describe("Agent that receives the channel's tasks."),
        workflowId: z
          .string()
          .optional()
          .describe("Workflow whose webhook trigger receives the channel's messages."),
        name: z.string().max(200).optional().describe("Display name for the mapping."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        key: z.string().optional(),
        mapping: z
          .looseObject({
            agentId: z.string().optional(),
            workflowId: z.string().optional(),
            name: z.string().optional(),
            createdAt: z.string().optional(),
          })
          .optional(),
      }),
    },
    async ({ adapter, channelId, agentId, workflowId, name }, requestInfo) => {
      const data = { yourAgentId: requestInfo.agentId };
      try {
        if (!(await canManageChatChannels(requestInfo))) {
          return toolErr("Permission denied. Only the lead can register a chat channel.", {
            data,
          });
        }
        if (Boolean(agentId) === Boolean(workflowId)) {
          return toolErr("Give exactly one of agentId or workflowId.", { data });
        }
        if (agentId && !(await getAgentById(agentId))) {
          return toolErr(`Agent ${agentId} not found.`, { data });
        }
        if (workflowId && !(await getWorkflow(workflowId))) {
          return toolErr(`Workflow ${workflowId} not found.`, { data });
        }
        const mapping: ChatChannelMapping = {
          ...(agentId ? { agentId } : {}),
          ...(workflowId ? { workflowId } : {}),
          ...(name ? { name } : {}),
          createdAt: new Date().toISOString(),
        };
        const key = await putChatChannelMapping(adapter, channelId, mapping);
        return toolOk(
          `Registered chat channel ${key} -> ${workflowId ? `workflow ${workflowId}` : `agent ${agentId}`}.`,
          { data: { ...data, key, mapping } },
        );
      } catch (error) {
        return toolErr(errorMessage(error), { data });
      }
    },
  );
};

export const registerUnregisterChatChannelTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "unregister-chat-channel",
    {
      title: "Remove a chat channel route",
      annotations: { idempotentHint: true },
      description:
        "Lead-only. Remove the channel-to-agent or channel-to-workflow route that register-chat-channel stored. Messages from the channel go back to the default route (thread owner, then the lead).",
      inputSchema: z.object({
        adapter: z.enum(CHAT_SDK_ADAPTER_NAMES).describe("Chat SDK adapter name."),
        channelId: z.string().min(1).describe("SDK channel id (prefix optional)."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        key: z.string().optional(),
      }),
    },
    async ({ adapter, channelId }, requestInfo) => {
      const data = { yourAgentId: requestInfo.agentId };
      try {
        if (!(await canManageChatChannels(requestInfo))) {
          return toolErr("Permission denied. Only the lead can unregister a chat channel.", {
            data,
          });
        }
        const key = chatChannelKey(adapter, channelId);
        const deleted = await deleteChatChannelMapping(adapter, channelId);
        return deleted
          ? toolOk(`Unregistered chat channel ${key}.`, { data: { ...data, key } })
          : toolErr(`No mapping found for chat channel ${key}.`, { data: { ...data, key } });
      } catch (error) {
        return toolErr(errorMessage(error), { data });
      }
    },
  );
};
