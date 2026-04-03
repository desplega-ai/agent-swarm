import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getSwarmRepos } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { SwarmRepoSchema } from "@/types";

export const registerGetReposTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-repos",
    {
      title: "Get Repos",
      description:
        "List registered repos with their guidelines (PR checks, merge policy, review guidance). Use the optional name filter to check a specific repo. The lead should use this to verify a repo has guidelines before routing tasks.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        name: z.string().optional().describe("Filter by repo name. If omitted, returns all repos."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        repos: z.array(SwarmRepoSchema),
        count: z.number(),
      }),
    },
    async ({ name }) => {
      const filters = name ? { name } : undefined;
      const repos = getSwarmRepos(filters);
      const count = repos.length;

      const repoList =
        count === 0
          ? "No repos found."
          : repos
              .map(
                (r) =>
                  `- ${r.name} (${r.url}) — guidelines: ${r.guidelines ? "configured" : "NOT SET"}`,
              )
              .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: count === 0 ? "No repos found." : `Found ${count} repo(s):\n\n${repoList}`,
          },
        ],
        structuredContent: {
          success: true,
          message: count === 0 ? "No repos found." : `Found ${count} repo(s).`,
          repos,
          count,
        },
      };
    },
  );
};
