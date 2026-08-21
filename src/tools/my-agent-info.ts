import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { AgentStatusSchema, ProviderNameSchema } from "@/types";

// Loose mirror of AgentSchema for tool output: every field optional, no
// datetime/uuid format pins, nested blobs collapsed to permissive objects.
const agentOutputShape = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  isLead: z.boolean().optional(),
  status: AgentStatusSchema.optional(),
  description: z.string().optional(),
  role: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  claudeMd: z.string().optional(),
  soulMd: z.string().optional(),
  identityMd: z.string().optional(),
  setupScript: z.string().optional(),
  toolsMd: z.string().optional(),
  heartbeatMd: z.string().optional(),
  maxTasks: z.number().optional(),
  emptyPollCount: z.number().optional(),
  lastActivityAt: z.string().optional(),
  provider: ProviderNameSchema.optional(),
  harnessProvider: ProviderNameSchema.nullable().optional(),
  credentialMissing: z.array(z.string()).nullable().optional(),
  credStatus: z.looseObject({}).nullable().optional(),
  avatar: z.looseObject({}).nullable().optional(),
  createdAt: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
});

export const registerMyAgentInfoTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "my-agent-info",
    {
      title: "Get your agent info",
      description: "Returns your agent ID based on the X-Agent-ID header.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({}),
      outputSchema: swarmToolOutputSchema({
        agentId: z.string().optional(),
        yourAgentId: z.string().optional(),
        yourAgentInfo: agentOutputShape.optional(),
      }),
    },
    async (_input, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr(
          'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
          { data: { yourAgentId: requestInfo.agentId } },
        );
      }

      const maybeAgent = await getAgentById(requestInfo.agentId);

      let registeredMessage =
        " You are not registered as an agent, use the 'join-swarm' tool to register, use a nice name related to the project you are working on if not provided by the user.";

      if (maybeAgent) {
        registeredMessage = ` You are registered as agent "${maybeAgent.name}".`;
      }

      return toolOk(`Your agent ID is: ${requestInfo.agentId}.${registeredMessage}`, {
        data: { yourAgentId: requestInfo.agentId, yourAgentInfo: maybeAgent },
      });
    },
  );
};
