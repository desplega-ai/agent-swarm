import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { findUserByEmail, findUserByExternalId } from "@/be/users";
import { createToolRegistrar } from "@/tools/utils";

/**
 * `resolve-user` — Q18 break-and-migrate shape:
 *   - `{kind, externalId}` for platform-identity lookups (replaces the old
 *     `slackUserId` / `linearUserId` / `githubUsername` / `gitlabUsername` fields).
 *   - `email` for primary-email or alias lookup.
 *
 * Validator requires either (kind + externalId) OR email. Old worker payloads
 * carrying `slackUserId`, `name`, etc. fail Zod validation at runtime — that
 * is the documented no-soak behaviour for this refactor.
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
  })
  .strict()
  .refine((v) => (v.kind !== undefined && v.externalId !== undefined) || v.email !== undefined, {
    message: "Provide either (kind + externalId) or email",
  });

export const registerResolveUserTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "resolve-user",
    {
      title: "Resolve user identity",
      description:
        "Look up a canonical user profile by an `(kind, externalId)` pair (e.g. {kind: 'slack', externalId: 'U_X'}) OR by email (primary or alias). Returns the user profile or 'No user found'.",
      annotations: { readOnlyHint: true },
      inputSchema: resolveUserInputSchema,
    },
    async ({ kind, externalId, email }) => {
      let user = null;
      if (kind && externalId) {
        user = findUserByExternalId(kind, externalId);
      } else if (email) {
        user = findUserByEmail(email);
      }

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
