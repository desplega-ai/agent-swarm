import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getMemoryStore } from "@/be/memory";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerMemoryDeleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory-delete",
    {
      title: "Delete a memory",
      description:
        "Delete a specific memory by its ID. Agents can delete their own memories; lead agents can also delete swarm-scoped memories.",
      annotations: { destructiveHint: true },

      inputSchema: z.object({
        memoryId: z.uuid().describe("The ID of the memory to delete."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
      }),
    },
    async ({ memoryId }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID required. Are you registered in the swarm?");
      }

      const store = getMemoryStore();
      const memory = await store.peek(memoryId);

      if (!memory) {
        return toolErr(`Memory "${memoryId}" not found.`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      // Permission check: own memories or lead can delete swarm-scoped
      const agent = await getAgentById(requestInfo.agentId);
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId,
          isLead: agent?.isLead ?? false,
        },
        verb: "memory.delete.any",
        resource: { kind: "owned", ownerAgentId: memory.agentId, scope: memory.scope },
        source: "mcp",
      });
      if (!decision.allow) {
        return toolErr(
          "Permission denied. You can only delete your own memories, or swarm memories if you are the lead.",
          { data: { yourAgentId: requestInfo.agentId } },
        );
      }

      const deleted = await store.delete(memoryId);

      const message = deleted
        ? `Memory "${memoryId}" deleted.`
        : `Failed to delete memory "${memoryId}".`;
      return deleted
        ? toolOk(message, { data: { yourAgentId: requestInfo.agentId } })
        : toolErr(message, { data: { yourAgentId: requestInfo.agentId } });
    },
  );
};
