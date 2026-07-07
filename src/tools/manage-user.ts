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
import {
  getUserIdentities,
  type IdentityActor,
  linkIdentity,
  recordIdentityEvent,
  unlinkIdentity,
} from "@/be/users";
import { can } from "@/rbac";
import { createToolRegistrar } from "@/tools/utils";

/**
 * `manage-user` — Q18 break-and-migrate shape:
 *   - Identities passed as `identities: [{kind, externalId}, ...]` (was previously
 *     four denormalised columns: slackUserId / linearUserId / githubUsername /
 *     gitlabUsername — all dropped).
 *   - `dailyBudgetUsd`, `status`, `metadata` are new (migration 064).
 *   - Update path computes a diff against the current `getUserIdentities(userId)`
 *     so the call is declarative: pass the full desired set, helper emits
 *     `identity_added` / `identity_removed` events for each delta.
 *   - Email-alias edits emit `email_added` / `email_removed` events (Q19).
 */
const IdentityEntry = z.object({
  kind: z.string().describe("Identity kind (e.g. 'slack', 'linear', 'github', 'gitlab', 'jira')."),
  externalId: z.string().describe("Platform-specific identifier for the given kind."),
});

const InputSchema = z.object({
  action: z.enum(["create", "update", "delete", "list", "get"]).describe("Action to perform"),
  userId: z.string().optional().describe("User ID (required for update/delete/get)"),
  name: z.string().optional().describe("Display name (required for create)"),
  email: z.string().optional().describe("Primary email address"),
  role: z.string().optional().describe('Role (e.g., "founder", "engineer")'),
  notes: z.string().optional().describe("Free-form notes"),
  identities: z
    .array(IdentityEntry)
    .optional()
    .describe(
      "List of platform identities to link. On create: every entry is linked. On update: the list is treated as the desired set — entries not currently linked are added (identity_added), entries currently linked but missing are removed (identity_removed).",
    ),
  emailAliases: z.array(z.string()).optional().describe("Additional email addresses"),
  preferredChannel: z.string().optional().describe("Preferred contact channel"),
  timezone: z.string().optional().describe("Timezone (e.g., America/New_York)"),
  dailyBudgetUsd: z
    .number()
    .nullable()
    .optional()
    .describe("Daily budget in USD (null clears the cap)"),
  status: z
    .enum(["invited", "active", "suspended"])
    .optional()
    .describe("User status — invited / active / suspended"),
  metadata: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe("Free-form JSON metadata (null clears the field)"),
});

function diffAliases(prev: string[], next: string[]): { added: string[]; removed: string[] } {
  const prevSet = new Set(prev.map((a) => a.toLowerCase()));
  const nextSet = new Set(next.map((a) => a.toLowerCase()));
  return {
    added: next.filter((a) => !prevSet.has(a.toLowerCase())),
    removed: prev.filter((a) => !nextSet.has(a.toLowerCase())),
  };
}

export const registerManageUserTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "manage-user",
    {
      title: "Manage user profiles",
      description:
        "Create, update, delete, or list user profiles in the user registry. Identities are managed via an `identities: [{kind, externalId}]` array (declarative — update computes diff). Lead-only.",
      annotations: { readOnlyHint: false },
      inputSchema: InputSchema,
    },
    async (input, requestInfo) => {
      const callerAgent = requestInfo.agentId ? getAgentById(requestInfo.agentId) : null;
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId ?? "",
          isLead: callerAgent?.isLead ?? false,
        },
        verb: "user.manage",
        resource: { kind: "none" },
        source: "mcp",
      });
      if (!decision.allow || !callerAgent) {
        return {
          content: [
            { type: "text" as const, text: "Only the lead agent can manage user profiles." },
          ],
        };
      }

      // Build the operator-actor used for every event emitted in this call.
      const operatorActor: IdentityActor = {
        kind: "operator",
        id: callerAgent.id,
      };

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
              emailAliases: input.emailAliases,
              preferredChannel: input.preferredChannel,
              timezone: input.timezone,
              dailyBudgetUsd: input.dailyBudgetUsd ?? undefined,
              status: input.status,
              metadata: input.metadata ?? undefined,
            });
            for (const ident of input.identities ?? []) {
              linkIdentity(user.id, ident.kind, ident.externalId, operatorActor);
            }
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
            const before = getUserById(input.userId);
            if (!before) {
              return {
                content: [{ type: "text" as const, text: `User ${input.userId} not found.` }],
              };
            }

            const user = updateUser(input.userId, {
              name: input.name,
              email: input.email,
              role: input.role,
              notes: input.notes,
              emailAliases: input.emailAliases,
              preferredChannel: input.preferredChannel,
              timezone: input.timezone,
              dailyBudgetUsd: input.dailyBudgetUsd,
              status: input.status,
              metadata: input.metadata,
            });
            if (!user) {
              return {
                content: [{ type: "text" as const, text: `User ${input.userId} not found.` }],
              };
            }

            // Identity diff — pass the desired set, helper emits the deltas.
            if (input.identities !== undefined) {
              const current = getUserIdentities(input.userId);
              const currentSet = new Set(current.map((i) => `${i.kind}:${i.externalId}`));
              const desiredSet = new Set(input.identities.map((i) => `${i.kind}:${i.externalId}`));

              for (const ident of input.identities) {
                if (!currentSet.has(`${ident.kind}:${ident.externalId}`)) {
                  linkIdentity(input.userId, ident.kind, ident.externalId, operatorActor);
                }
              }
              for (const ident of current) {
                if (!desiredSet.has(`${ident.kind}:${ident.externalId}`)) {
                  unlinkIdentity(input.userId, ident.kind, ident.externalId, operatorActor);
                }
              }
            }

            // Email alias diff — emit dedicated email_added / email_removed events (Q19).
            if (input.emailAliases !== undefined) {
              const { added, removed } = diffAliases(before.emailAliases, input.emailAliases);
              for (const alias of added) {
                recordIdentityEvent(input.userId, "email_added", operatorActor, null, { alias });
              }
              for (const alias of removed) {
                recordIdentityEvent(input.userId, "email_removed", operatorActor, { alias }, null);
              }
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
