import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { updateSwarmRepo } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { RepoGuidelinesSchema, SwarmRepoSchema } from "@/types";

export const registerUpdateRepoTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "update-repo",
    {
      title: "Update Repo",
      description:
        "Update a repo's configuration including guidelines (PR checks, merge policy, review guidance). The lead uses this to set guidelines after asking the user. Pass null for guidelines to clear them.",
      annotations: { readOnlyHint: false },

      inputSchema: z.object({
        id: z.string().uuid().describe("The repo ID to update."),
        url: z.string().optional().describe("New repo URL."),
        name: z.string().optional().describe("New repo name."),
        clonePath: z.string().optional().describe("New clone path."),
        defaultBranch: z.string().optional().describe("New default branch."),
        autoClone: z.boolean().optional().describe("Whether to auto-clone."),
        guidelines: RepoGuidelinesSchema.nullable()
          .optional()
          .describe(
            "Repository guidelines: prChecks (commands before PR), mergeChecks (conditions before merge), allowMerge (default false), review (guidance for reviewers). Pass null to clear.",
          ),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        repo: SwarmRepoSchema.nullable(),
      }),
    },
    async ({ id, ...updates }) => {
      const updated = updateSwarmRepo(id, updates);

      if (!updated) {
        return {
          content: [{ type: "text" as const, text: `Repo not found: ${id}` }],
          structuredContent: {
            success: false,
            message: `Repo not found: ${id}`,
            repo: null,
          },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Updated repo "${updated.name}" — guidelines: ${updated.guidelines ? "configured" : "not set"}`,
          },
        ],
        structuredContent: {
          success: true,
          message: `Updated repo "${updated.name}".`,
          repo: updated,
        },
      };
    },
  );
};
