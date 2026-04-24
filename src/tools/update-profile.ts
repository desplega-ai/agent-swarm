import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, updateAgentName, updateAgentProfile } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { type Agent, AgentSchema } from "@/types";

export const registerUpdateProfileTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "update-profile",
    {
      title: "Update Profile",
      description:
        "Updates an agent's profile information (name, description, role, capabilities). By default updates the calling agent. Lead agents can update any agent's profile by providing the agentId parameter.",
      annotations: { idempotentHint: true },

      inputSchema: z.object({
        agentId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Target agent ID to update. If omitted, updates the calling agent. Only lead agents can update other agents' profiles.",
          ),
        name: z.string().min(1).optional().describe("Agent name."),
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
        claudeMd: z
          .string()
          .max(65536)
          .optional()
          .describe(
            "Personal CLAUDE.md content. Loaded on session start and synced back on session end. Use for persistent notes and instructions.",
          ),
        soulMd: z
          .string()
          .min(200)
          .max(65536)
          .optional()
          .describe(
            "Soul content: persona and behavioral directives. Updates both DB and /workspace/SOUL.md. Must be at least 200 characters to prevent accidental corruption.",
          ),
        identityMd: z
          .string()
          .min(200)
          .max(65536)
          .optional()
          .describe(
            "Identity content: expertise and working style. Updates both DB and /workspace/IDENTITY.md. Must be at least 200 characters to prevent accidental corruption.",
          ),
        setupScript: z
          .string()
          .max(65536)
          .optional()
          .describe(
            "Setup script content (bash). Runs at container start to install tools, configure environment. Persists across sessions. Also written to /workspace/start-up.sh.",
          ),
        toolsMd: z
          .string()
          .max(65536)
          .optional()
          .describe(
            "Environment-specific operational knowledge. Repos, services, SSH hosts, APIs, device names — anything specific to your setup. Synced to /workspace/TOOLS.md.",
          ),
        heartbeatMd: z
          .string()
          .max(65536)
          .optional()
          .describe(
            "Heartbeat checklist content (HEARTBEAT.md). Checked periodically — add standing orders for the lead to review. Synced to /workspace/HEARTBEAT.md.",
          ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        agent: AgentSchema.optional(),
      }),
    },
    async (
      {
        agentId,
        name,
        description,
        role,
        capabilities,
        claudeMd,
        soulMd,
        identityMd,
        setupScript,
        toolsMd,
        heartbeatMd,
      },
      requestInfo,
      _meta,
    ) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      // Determine target agent: if agentId is provided, check lead permissions
      const isUpdatingSelf = !agentId || agentId === requestInfo.agentId;
      const targetAgentId = isUpdatingSelf ? requestInfo.agentId : agentId;

      if (!isUpdatingSelf) {
        // Only lead agents can update other agents' profiles
        const callingAgent = getAgentById(requestInfo.agentId);
        if (!callingAgent) {
          return {
            content: [{ type: "text", text: "Calling agent not found." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Calling agent not found.",
            },
          };
        }
        if (!callingAgent.isLead) {
          return {
            content: [
              {
                type: "text",
                text: "Only lead agents can update other agents' profiles. Provide no agentId to update your own profile.",
              },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message:
                "Only lead agents can update other agents' profiles. Provide no agentId to update your own profile.",
            },
          };
        }

        // Validate target agent exists before proceeding
        const targetAgent = getAgentById(targetAgentId);
        if (!targetAgent) {
          return {
            content: [{ type: "text", text: `Target agent ${targetAgentId} not found.` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Target agent ${targetAgentId} not found.`,
            },
          };
        }
      }

      // At least one field must be provided
      if (
        name === undefined &&
        description === undefined &&
        role === undefined &&
        capabilities === undefined &&
        claudeMd === undefined &&
        soulMd === undefined &&
        identityMd === undefined &&
        setupScript === undefined &&
        toolsMd === undefined &&
        heartbeatMd === undefined
      ) {
        return {
          content: [
            {
              type: "text",
              text: "At least one field (name, description, role, capabilities, claudeMd, soulMd, identityMd, setupScript, toolsMd, or heartbeatMd) must be provided.",
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message:
              "At least one field (name, description, role, capabilities, claudeMd, soulMd, identityMd, setupScript, toolsMd, or heartbeatMd) must be provided.",
          },
        };
      }

      try {
        let agent: Agent | null = null;

        // Update name if provided
        if (name !== undefined) {
          agent = updateAgentName(targetAgentId, name);
          if (!agent) {
            return {
              content: [{ type: "text", text: "Target agent not found." }],
              structuredContent: {
                yourAgentId: requestInfo.agentId,
                success: false,
                message: "Target agent not found.",
              },
            };
          }
        }

        // Update profile fields if provided
        agent = updateAgentProfile(
          targetAgentId,
          {
            description,
            role,
            capabilities,
            claudeMd,
            soulMd,
            identityMd,
            setupScript,
            toolsMd,
            heartbeatMd,
          },
          {
            changeSource: isUpdatingSelf ? "self_edit" : "lead_coaching",
            changedByAgentId: requestInfo.agentId,
          },
        );

        // Write updated files to workspace only when updating self AND the caller
        // matches the real running agent (process.env.AGENT_ID). This guards against
        // unit tests (with fake WORKER_IDs) accidentally overwriting the container's
        // SOUL.md/IDENTITY.md when the test suite runs inside a real agent container.
        // (remote agent files live on their own container)
        if (isUpdatingSelf && requestInfo.agentId === process.env.AGENT_ID) {
          if (soulMd !== undefined) {
            try {
              await Bun.write("/workspace/SOUL.md", soulMd);
            } catch {
              /* ignore */
            }
          }
          if (identityMd !== undefined) {
            try {
              await Bun.write("/workspace/IDENTITY.md", identityMd);
            } catch {
              /* ignore */
            }
          }
          if (setupScript !== undefined) {
            try {
              await Bun.write("/workspace/start-up.sh", `#!/bin/bash\n${setupScript}\n`);
            } catch {
              /* ignore */
            }
          }
          if (toolsMd !== undefined) {
            try {
              await Bun.write("/workspace/TOOLS.md", toolsMd);
            } catch {
              /* ignore */
            }
          }
          if (heartbeatMd !== undefined) {
            try {
              await Bun.write("/workspace/HEARTBEAT.md", heartbeatMd);
            } catch {
              /* ignore */
            }
          }
        }

        if (!agent) {
          return {
            content: [{ type: "text", text: "Agent not found." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Agent not found.",
            },
          };
        }

        const updatedFields: string[] = [];
        if (name !== undefined) updatedFields.push("name");
        if (description !== undefined) updatedFields.push("description");
        if (role !== undefined) updatedFields.push("role");
        if (capabilities !== undefined) updatedFields.push("capabilities");
        if (claudeMd !== undefined) updatedFields.push("claudeMd");
        if (soulMd !== undefined) updatedFields.push("soulMd");
        if (identityMd !== undefined) updatedFields.push("identityMd");
        if (setupScript !== undefined) updatedFields.push("setupScript");
        if (toolsMd !== undefined) updatedFields.push("toolsMd");
        if (heartbeatMd !== undefined) updatedFields.push("heartbeatMd");

        const targetLabel = isUpdatingSelf ? "own" : `agent ${targetAgentId}`;
        return {
          content: [
            { type: "text", text: `Updated ${targetLabel} profile: ${updatedFields.join(", ")}.` },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Updated ${targetLabel} profile: ${updatedFields.join(", ")}.`,
            agent,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to update profile: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to update profile: ${message}`,
          },
        };
      }
    },
  );
};
