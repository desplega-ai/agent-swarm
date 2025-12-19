import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createAgent, getAllAgents, getDb, updateAgentProfile } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentSchema } from "@/types";

export const registerJoinSwarmTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "join-swarm",
    {
      title: "Join the agent swarm",
      description:
        "Tool for an agent to join the swarm of agents with optional profile information.",
      inputSchema: z.object({
        requestedId: z
          .string()
          .optional()
          .describe("Requested ID for the agent (overridden by X-Agent-ID header)."),
        lead: z.boolean().default(false).describe("Whether this agent should be the lead."),
        name: z.string().min(1).describe("The name of the agent joining the swarm."),
        description: z.string().max(500).optional().describe("Agent description (max 500 chars)."),
        role: z
          .string()
          .max(100)
          .optional()
          .describe("Agent role (free-form, e.g., 'frontend dev', 'code reviewer')."),
        capabilities: z
          .array(z.string())
          .optional()
          .describe("List of capabilities (e.g., ['typescript', 'react', 'testing'])."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        agent: AgentSchema.optional(),
      }),
    },
    async ({ lead, name, requestedId, description, role, capabilities }, requestInfo, _meta) => {
      // Check if agent ID is set
      if (!requestInfo.agentId && !requestedId) {
        return {
          content: [
            {
              type: "text",
              text: 'Agent ID not found. The MCP client should define the "X-Agent-ID" header, or provide a requestedId.',
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId ?? requestedId,
            success: false,
            message:
              'Agent ID not found. The MCP client should define the "X-Agent-ID" header, or provide a requestedId.',
          },
        };
      }

      const agentId = requestInfo.agentId ?? requestedId ?? "";

      try {
        const agentTx = getDb().transaction(() => {
          const agents = getAllAgents();

          const existingIdAgent = agents.find((agent) => agent.id === agentId);

          if (existingIdAgent) {
            throw new Error(`Agent with ID "${agentId}" already exists.`);
          }

          const existingAgent = agents.find((agent) => agent.name === name);

          if (existingAgent) {
            throw new Error(`Agent with name "${name}" already exists.`);
          }

          const existingLead = agents.find((agent) => agent.isLead);

          // If lead is true, demote e
          if (lead && existingLead) {
            throw new Error(
              `Lead agent "${existingLead.name}" already exists. Only one lead agent is allowed.`,
            );
          }

          const agent = createAgent({
            id: agentId,
            name,
            isLead: lead,
            status: "idle",
            capabilities: [],
          });

          // Update profile if any profile fields were provided
          if (description !== undefined || role !== undefined || capabilities !== undefined) {
            const updatedAgent = updateAgentProfile(agent.id, {
              description,
              role,
              capabilities,
            });
            return updatedAgent ?? agent;
          }

          return agent;
        });

        const agent = agentTx();

        return {
          content: [
            {
              type: "text",
              text: `Successfully joined swarm as ${agent.isLead ? "Lead" : "Worker"} agent "${agent.name}" (ID: ${agent.id}).`,
            },
          ],
          structuredContent: {
            yourAgentId: agent.id,
            success: true,
            message: `Successfully joined swarm as ${agent.isLead ? "Lead" : "Worker"} agent "${agent.name}" (ID: ${agent.id}).`,
            agent,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to join swarm: ${(error as Error).message}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId ?? requestedId,
            success: false,
            message: `Failed to join swarm: ${(error as Error).message}`,
          },
        };
      }
    },
  );
};
