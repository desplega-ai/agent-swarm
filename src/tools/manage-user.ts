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
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

// Loose mirror of UserSchema for tool output: every field optional, no
// datetime format pins.
const userOutputShape = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  role: z.string().optional(),
  notes: z.string().optional(),
  emailAliases: z.array(z.string()).optional(),
  preferredChannel: z.string().optional(),
  timezone: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  dailyBudgetUsd: z.number().nullable().optional(),
  status: z.enum(["invited", "active", "suspended"]).optional(),
  createdAt: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
});

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
  comms: z
    .object({
      tone: z.string().optional(),
      language: z.string().optional(),
      verbosity: z.string().optional(),
    })
    .nullable()
    .optional()
    .describe(
      "Merge-safe write to metadata.comms without touching sibling metadata keys; null removes only the comms key. When metadata is also provided, it is applied first and replaces the whole blob.",
    ),
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
        "Create, update, delete, or list user profiles in the user registry. Identities are managed via an `identities: [{kind, externalId}]` array (declarative — update computes diff). comms is the merge-safe way to set communication preferences; metadata replaces the whole blob. Lead-only.",
      annotations: { readOnlyHint: false },
      inputSchema: InputSchema,
      outputSchema: swarmToolOutputSchema({
        users: z.array(userOutputShape).optional(),
        user: userOutputShape.optional(),
      }),
    },
    async (input, requestInfo) => {
      const callerAgent = requestInfo.agentId ? await getAgentById(requestInfo.agentId) : null;
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
        return toolErr("Only the lead agent can manage user profiles.");
      }

      // Build the operator-actor used for every event emitted in this call.
      const operatorActor: IdentityActor = {
        kind: "operator",
        id: callerAgent.id,
      };

      switch (input.action) {
        case "list": {
          const users = await getAllUsers();
          return toolOk(`Found ${users.length} user(s).`, {
            details: JSON.stringify(users, null, 2),
            data: { users },
          });
        }

        case "get": {
          if (!input.userId) {
            return toolErr("userId is required for get action.");
          }
          const user = await getUserById(input.userId);
          if (!user) {
            return toolErr(`User ${input.userId} not found.`);
          }
          return toolOk(`Found user "${user.name}" (${user.id}).`, {
            details: JSON.stringify(user, null, 2),
            data: { user },
          });
        }

        case "create": {
          if (!input.name) {
            return toolErr("name is required for create action.");
          }
          try {
            const metadata =
              input.comms != null
                ? { ...(input.metadata ?? {}), comms: input.comms }
                : (input.metadata ?? undefined);
            const user = await createUser({
              name: input.name,
              email: input.email,
              role: input.role,
              notes: input.notes,
              emailAliases: input.emailAliases,
              preferredChannel: input.preferredChannel,
              timezone: input.timezone,
              dailyBudgetUsd: input.dailyBudgetUsd ?? undefined,
              status: input.status,
              metadata,
            });
            for (const ident of input.identities ?? []) {
              await linkIdentity(user.id, ident.kind, ident.externalId, operatorActor);
            }
            return toolOk(`User created: "${user.name}" (${user.id}).`, {
              details: JSON.stringify(user, null, 2),
              data: { user },
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return toolErr(`Failed to create user: ${message}`);
          }
        }

        case "update": {
          if (!input.userId) {
            return toolErr("userId is required for update action.");
          }
          try {
            const before = await getUserById(input.userId);
            if (!before) {
              return toolErr(`User ${input.userId} not found.`);
            }

            // Merge-safe write: metadata (if provided) is applied first and
            // replaces the whole blob, then comms is merged into it so
            // sibling metadata keys survive.
            let metadata = input.metadata;
            if (input.comms !== undefined) {
              const base: Record<string, unknown> = {
                ...(input.metadata !== undefined
                  ? (input.metadata ?? {})
                  : (before.metadata ?? {})),
              };
              if (input.comms === null) {
                delete base.comms;
              } else {
                base.comms = input.comms;
              }
              metadata = Object.keys(base).length > 0 ? base : null;
            }

            const user = await updateUser(input.userId, {
              name: input.name,
              email: input.email,
              role: input.role,
              notes: input.notes,
              emailAliases: input.emailAliases,
              preferredChannel: input.preferredChannel,
              timezone: input.timezone,
              dailyBudgetUsd: input.dailyBudgetUsd,
              status: input.status,
              metadata,
            });
            if (!user) {
              return toolErr(`User ${input.userId} not found.`);
            }

            // Identity diff — pass the desired set, helper emits the deltas.
            if (input.identities !== undefined) {
              const current = await getUserIdentities(input.userId);
              const currentSet = new Set(current.map((i) => `${i.kind}:${i.externalId}`));
              const desiredSet = new Set(input.identities.map((i) => `${i.kind}:${i.externalId}`));

              for (const ident of input.identities) {
                if (!currentSet.has(`${ident.kind}:${ident.externalId}`)) {
                  await linkIdentity(input.userId, ident.kind, ident.externalId, operatorActor);
                }
              }
              for (const ident of current) {
                if (!desiredSet.has(`${ident.kind}:${ident.externalId}`)) {
                  await unlinkIdentity(input.userId, ident.kind, ident.externalId, operatorActor);
                }
              }
            }

            // Email alias diff — emit dedicated email_added / email_removed events (Q19).
            if (input.emailAliases !== undefined) {
              const { added, removed } = diffAliases(before.emailAliases, input.emailAliases);
              for (const alias of added) {
                await recordIdentityEvent(input.userId, "email_added", operatorActor, null, {
                  alias,
                });
              }
              for (const alias of removed) {
                await recordIdentityEvent(
                  input.userId,
                  "email_removed",
                  operatorActor,
                  { alias },
                  null,
                );
              }
            }

            return toolOk(`User updated: "${user.name}" (${user.id}).`, {
              details: JSON.stringify(user, null, 2),
              data: { user },
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return toolErr(`Failed to update user: ${message}`);
          }
        }

        case "delete": {
          if (!input.userId) {
            return toolErr("userId is required for delete action.");
          }
          const deleted = await deleteUser(input.userId);
          return deleted
            ? toolOk(`User ${input.userId} deleted.`)
            : toolErr(`User ${input.userId} not found.`);
        }

        default:
          return toolErr(`Unknown action: ${input.action}`);
      }
    },
  );
};
