import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  createUser,
  deleteUser,
  getAgentById,
  getAllUsers,
  getUserById,
  updateUser,
} from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerManageUserTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "manage-user",
    {
      title: "Manage user profiles",
      description: "Create, update, delete, or list user profiles in the user registry. Lead-only.",
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        action: z.enum(["create", "update", "delete", "list", "get"]).describe("Action to perform"),
        userId: z.string().optional().describe("User ID (required for update/delete/get)"),
        name: z.string().optional().describe("Display name (required for create)"),
        email: z.string().optional().describe("Primary email address"),
        role: z.string().optional().describe('Role (e.g., "founder", "engineer")'),
        notes: z.string().optional().describe("Free-form notes"),
        slackUserId: z.string().optional().describe("Slack user ID"),
        linearUserId: z.string().optional().describe("Linear user UUID"),
        githubUsername: z.string().optional().describe("GitHub username"),
        gitlabUsername: z.string().optional().describe("GitLab username"),
        emailAliases: z.array(z.string()).optional().describe("Additional email addresses"),
        preferredChannel: z.string().optional().describe("Preferred contact channel"),
        timezone: z.string().optional().describe("Timezone (e.g., America/New_York)"),
      }),
    },
    async (input, requestInfo) => {
      const callerAgent = requestInfo.agentId ? getAgentById(requestInfo.agentId) : null;
      if (!callerAgent?.isLead) {
        return {
          content: [
            { type: "text" as const, text: "Only the lead agent can manage user profiles." },
          ],
        };
      }

      switch (input.action) {
        case "list": {
          const users = getAllUsers();
          return {
            content: [{ type: "text" as const, text: JSON.stringify(users, null, 2) }],
          };
        }

        case "get": {
          if (!input.userId) {
            return {
              content: [{ type: "text" as const, text: "userId is required for get action." }],
            };
          }
          const user = getUserById(input.userId);
          if (!user) {
            return {
              content: [{ type: "text" as const, text: `User ${input.userId} not found.` }],
            };
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(user, null, 2) }],
          };
        }

        case "create": {
          if (!input.name) {
            return {
              content: [{ type: "text" as const, text: "name is required for create action." }],
            };
          }
          try {
            const user = createUser({
              name: input.name,
              email: input.email,
              role: input.role,
              notes: input.notes,
              slackUserId: input.slackUserId,
              linearUserId: input.linearUserId,
              githubUsername: input.githubUsername,
              gitlabUsername: input.gitlabUsername,
              emailAliases: input.emailAliases,
              preferredChannel: input.preferredChannel,
              timezone: input.timezone,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `User created: ${JSON.stringify(user, null, 2)}`,
                },
              ],
            };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Failed to create user: ${message}` }],
            };
          }
        }

        case "update": {
          if (!input.userId) {
            return {
              content: [{ type: "text" as const, text: "userId is required for update action." }],
            };
          }
          try {
            const user = updateUser(input.userId, {
              name: input.name,
              email: input.email,
              role: input.role,
              notes: input.notes,
              slackUserId: input.slackUserId,
              linearUserId: input.linearUserId,
              githubUsername: input.githubUsername,
              gitlabUsername: input.gitlabUsername,
              emailAliases: input.emailAliases,
              preferredChannel: input.preferredChannel,
              timezone: input.timezone,
            });
            if (!user) {
              return {
                content: [{ type: "text" as const, text: `User ${input.userId} not found.` }],
              };
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: `User updated: ${JSON.stringify(user, null, 2)}`,
                },
              ],
            };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Failed to update user: ${message}` }],
            };
          }
        }

        case "delete": {
          if (!input.userId) {
            return {
              content: [{ type: "text" as const, text: "userId is required for delete action." }],
            };
          }
          const deleted = deleteUser(input.userId);
          return {
            content: [
              {
                type: "text" as const,
                text: deleted ? `User ${input.userId} deleted.` : `User ${input.userId} not found.`,
              },
            ],
          };
        }

        default:
          return {
            content: [{ type: "text" as const, text: `Unknown action: ${input.action}` }],
          };
      }
    },
  );
};
