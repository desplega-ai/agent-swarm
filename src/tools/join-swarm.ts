import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createAgent, getAllAgents, getDb, updateAgentProfile } from "@/be/db";
import {
  generateDefaultClaudeMd,
  generateDefaultIdentityMd,
  generateDefaultSoulMd,
} from "@/prompts/defaults";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { AgentStatusSchema, ProviderNameSchema } from "@/types";

// Loose mirror of AgentSchema for tool output: every field optional, no
// datetime/uuid format pins, nested blobs collapsed to permissive objects.
// (Mirrored locally per runbooks/mcp-tool-results.md — output schemas must be
// loose and can't reuse the strict, format-pinned domain schema directly.)
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

export const registerJoinSwarmTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "join-swarm",
    {
      title: "Join the agent swarm",
      description:
        "Tool for an agent to join the swarm of agents with optional profile information.",
      annotations: { idempotentHint: true },

      inputSchema: z.object({
        requestedId: z
          .string()
          .optional()
          .describe("Requested ID for the agent (overridden by X-Agent-ID header)."),
        lead: z.boolean().default(false).describe("Whether this agent should be the lead."),
        name: z.string().min(1).describe("The name of the agent joining the swarm."),
        description: z.string().optional().describe("Agent description."),
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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        agent: agentOutputShape.optional(),
      }),
    },
    async ({ lead, name, requestedId, description, role, capabilities }, requestInfo, _meta) => {
      // Check if agent ID is set
      if (!requestInfo.agentId && !requestedId) {
        return toolErr(
          'Agent ID not found. The MCP client should define the "X-Agent-ID" header, or provide a requestedId.',
          { data: { yourAgentId: requestInfo.agentId ?? requestedId } },
        );
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

          // Generate default CLAUDE.md, SOUL.md, and IDENTITY.md
          const defaultClaudeMd = generateDefaultClaudeMd({
            name,
            description,
            role,
            capabilities,
          });
          const defaultSoulMd = generateDefaultSoulMd({ name, role });
          const defaultIdentityMd = generateDefaultIdentityMd({
            name,
            description,
            role,
            capabilities,
          });

          // Update profile with any provided fields and the default templates
          const updatedAgent = updateAgentProfile(agent.id, {
            description,
            role,
            capabilities,
            claudeMd: defaultClaudeMd,
            soulMd: defaultSoulMd,
            identityMd: defaultIdentityMd,
          });

          return updatedAgent ?? agent;
        });

        const agent = agentTx();

        return toolOk(
          `Successfully joined swarm as ${agent.isLead ? "Lead" : "Worker"} agent "${agent.name}" (ID: ${agent.id}).`,
          { data: { yourAgentId: agent.id, agent } },
        );
      } catch (error) {
        return toolErr(`Failed to join swarm: ${(error as Error).message}`, {
          data: { yourAgentId: requestInfo.agentId ?? requestedId },
        });
      }
    },
  );
};
