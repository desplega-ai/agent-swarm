import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAllAgents } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolOk } from "@/tools/utils";
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

export const registerGetSwarmTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-swarm",
    {
      title: "Get the agent swarm",
      description:
        "Returns a list of agents in the swarm without their tasks. Identity markdown (claudeMd/soulMd/identityMd/toolsMd/heartbeatMd/setupScript) is omitted by default — pass includeFull:true to include it.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        a: z.string().optional(),
        includeFull: z
          .boolean()
          .optional()
          .describe(
            "Include the six identity-markdown blobs (claudeMd/soulMd/identityMd/toolsMd/heartbeatMd/setupScript). Default false — they are large and rarely needed at the swarm-overview level.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        agents: z.array(agentOutputShape).optional(),
      }),
    },
    async ({ includeFull }, requestInfo, _meta) => {
      const agents = await getAllAgents({ slim: !includeFull });

      // Include the ID — send-task targets agents by ID, and text-only
      // harnesses never see the structured data to look it up.
      const agentList = agents
        .map((a) => `- ${a.name} (${a.status}${a.isLead ? ", lead" : ""}) — id: ${a.id}`)
        .join("\n");

      return toolOk(
        `Found ${agents.length} agent(s) in the swarm. Requested by session: ${requestInfo.sessionId}`,
        {
          details: agentList || undefined,
          data: { yourAgentId: requestInfo.agentId, agents },
        },
      );
    },
  );
};
