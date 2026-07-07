import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, updateAgentName, updateAgentProfile } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar } from "@/tools/utils";
import { type Agent, AgentSchema } from "@/types";

async function validateSetupScriptSyntax(setupScript: string): Promise<string | null> {
  const proc = Bun.spawn(["bash", "-n", "-c", setupScript], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  if (exitCode === 0) return null;
  return stderr.trim() || `bash -n exited with code ${exitCode}`;
}

async function computeSetupScriptDiff(before: string, after: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "setup-script-diff-"));
  const beforePath = join(dir, "before.sh");
  const afterPath = join(dir, "after.sh");

  try {
    await Bun.write(beforePath, before);
    await Bun.write(afterPath, after);

    const proc = Bun.spawn(
      ["diff", "-u", "--label", "before", "--label", "after", beforePath, afterPath],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode === 0) return "(no changes)";
    if (exitCode === 1) return stdout.trimEnd();
    return `diff failed with code ${exitCode}: ${stderr.trim()}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
            "Setup script content (bash). Runs at container start as the worker user after privilege drop. Persists across sessions. Also written to /workspace/start-up.sh.",
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
        const decision = can({
          principal: { kind: "agent", agentId: callingAgent.id, isLead: callingAgent.isLead },
          verb: "agent.profile.update.any",
          resource: { kind: "agent", agentId: targetAgentId },
          source: "mcp",
        });
        if (!decision.allow) {
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
        const previousSetupScript =
          setupScript !== undefined ? (getAgentById(targetAgentId)?.setupScript ?? "") : undefined;

        if (setupScript !== undefined) {
          const syntaxError = await validateSetupScriptSyntax(setupScript);
          if (syntaxError) {
            return {
              content: [{ type: "text", text: `Invalid setupScript: ${syntaxError}` }],
              structuredContent: {
                yourAgentId: requestInfo.agentId,
                success: false,
                message: `Invalid setupScript: ${syntaxError}`,
              },
            };
          }
        }

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

        if (setupScript !== undefined && previousSetupScript !== undefined) {
          try {
            const diff = await computeSetupScriptDiff(previousSetupScript, setupScript);
            console.warn(
              [
                "[audit] setupScript updated via update-profile",
                `targetAgentId=${targetAgentId}`,
                `changedByAgentId=${requestInfo.agentId}`,
                `changeSource=${isUpdatingSelf ? "self_edit" : "lead_coaching"}`,
                `beforeBytes=${Buffer.byteLength(previousSetupScript, "utf8")}`,
                `afterBytes=${Buffer.byteLength(setupScript, "utf8")}`,
                "diff:",
                diff,
              ].join("\n"),
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(
              `[audit] setupScript updated via update-profile but diff logging failed targetAgentId=${targetAgentId} changedByAgentId=${requestInfo.agentId}: ${message}`,
            );
          }
        }

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
