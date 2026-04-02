import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { resolveUser } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerResolveUserTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "resolve-user",
    {
      title: "Resolve user identity",
      description:
        "Look up a canonical user profile by any platform-specific identifier (Slack ID, Linear ID, GitHub username, email, or name). Returns the full user profile or null.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        slackUserId: z.string().optional().describe("Slack user ID (e.g., U08NR6QD6CS)"),
        linearUserId: z.string().optional().describe("Linear user UUID"),
        githubUsername: z.string().optional().describe("GitHub username"),
        gitlabUsername: z.string().optional().describe("GitLab username"),
        email: z.string().optional().describe("Email address"),
        name: z.string().optional().describe("Name (fuzzy substring match, lowest priority)"),
      }),
    },
    async ({ slackUserId, linearUserId, githubUsername, gitlabUsername, email, name }) => {
      if (!slackUserId && !linearUserId && !githubUsername && !gitlabUsername && !email && !name) {
        return {
          content: [
            {
              type: "text" as const,
              text: "At least one search parameter is required.",
            },
          ],
        };
      }

      const user = resolveUser({
        slackUserId,
        linearUserId,
        githubUsername,
        gitlabUsername,
        email,
        name,
      });

      if (!user) {
        return {
          content: [{ type: "text" as const, text: "No user found matching the given criteria." }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(user, null, 2) }],
      };
    },
  );
};
