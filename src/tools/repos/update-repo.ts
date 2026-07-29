import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { updateSwarmRepo } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { RepoGuidelinesSchema, RepoHooksSchema } from "@/types";

const swarmRepoOutputShape = z.looseObject({
  id: z.string().optional(),
  url: z.string().optional(),
  name: z.string().optional(),
  clonePath: z.string().optional(),
  defaultBranch: z.string().optional(),
  autoClone: z.boolean().optional(),
  hooks: z.looseObject({ enabled: z.boolean().optional() }).optional(),
  guidelines: z
    .looseObject({
      prChecks: z.array(z.string()).optional(),
      mergeChecks: z.array(z.string()).optional(),
      allowMerge: z.boolean().optional(),
      review: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  createdAt: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
});

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
        hooks: RepoHooksSchema.nullable()
          .optional()
          .describe(
            "Repository hook install config. Set { enabled: true } to opt into best-effort worker hook installation, or null to disable.",
          ),
        guidelines: RepoGuidelinesSchema.nullable()
          .optional()
          .describe(
            "Repository guidelines: prChecks (commands before PR), mergeChecks (conditions before merge), allowMerge (default false), review (guidance for reviewers). Pass null to clear.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        repo: swarmRepoOutputShape.nullable().optional(),
      }),
    },
    async ({ id, ...updates }) => {
      const updated = updateSwarmRepo(id, updates);

      if (!updated) {
        return toolErr(`Repo not found: ${id}`, { data: { repo: null } });
      }

      return toolOk(`Updated repo "${updated.name}".`, {
        details: `Updated repo "${updated.name}" — guidelines: ${updated.guidelines ? "configured" : "not set"}`,
        data: { repo: updated },
      });
    },
  );
};
