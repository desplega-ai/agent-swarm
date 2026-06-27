import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolRegistrar } from "@swarm/mcp-tool";
import {
  findUserByEmail,
  findUserByExternalId,
  findUserById,
  getUserIdentities,
} from "@swarm/storage";
import * as z from "zod";

/**
 * `resolve-user` — Q18 break-and-migrate shape:
 *   - `{kind, externalId}` for platform-identity lookups (replaces the old
 *     `slackUserId` / `linearUserId` / `githubUsername` / `gitlabUsername` fields).
 *   - `email` for primary-email or alias lookup.
 *   - `userId` for direct canonical-ID lookup (reverse-resolution: "give me
 *     all external IDs for this swarm user").
 *
 * Validator requires either (kind + externalId) OR email OR userId.
 *
 * Exported for tests so the schema can be validated without spinning up an
 * MCP transport (the SDK only runs Zod at the transport layer).
 */
export const resolveUserInputSchema = z
  .object({
    kind: z
      .string()
      .optional()
      .describe(
        "Identity kind — e.g. 'slack', 'linear', 'github', 'gitlab', 'jira', or a custom value. Must be paired with externalId.",
      ),
    externalId: z
      .string()
      .optional()
      .describe(
        "Platform-specific identifier for the given kind (e.g. Slack user ID 'U08NR6QD6CS', Linear user UUID, GitHub login).",
      ),
    email: z.string().email().optional().describe("Email address (primary or alias)."),
    userId: z
      .string()
      .optional()
      .describe(
        "Canonical swarm user ID. Use this to reverse-look up all external identities for a known user (e.g. find their GitHub handle from a requestedByUserId).",
      ),
  })
  .strict()
  .refine(
    (v) =>
      (v.kind !== undefined && v.externalId !== undefined) ||
      v.email !== undefined ||
      v.userId !== undefined,
    { message: "Provide either (kind + externalId), email, or userId" },
  );

export const registerResolveUserTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "resolve-user",
    {
      title: "Resolve user identity",
      description:
        "Look up a canonical user profile by an `(kind, externalId)` pair (e.g. {kind: 'slack', externalId: 'U_X'}), by email (primary or alias), or by swarm `userId`. Returns the user profile including `externalIds` (all linked platform identities) or 'No user found'.",
      annotations: { readOnlyHint: true },
      inputSchema: resolveUserInputSchema,
    },
    async ({ kind, externalId, email, userId }) => {
      let user = null;
      if (kind && externalId) {
        user = findUserByExternalId(kind, externalId);
      } else if (email) {
        user = findUserByEmail(email);
      } else if (userId) {
        user = findUserById(userId);
      }

      if (!user) {
        return {
          content: [{ type: "text" as const, text: "No user found matching the given criteria." }],
        };
      }

      const externalIds = getUserIdentities(user.id);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ ...user, externalIds }, null, 2) },
        ],
      };
    },
  );
};
