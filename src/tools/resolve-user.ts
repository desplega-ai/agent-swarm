import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { resolveIdentity, resolveIdentityByEmail } from "@/be/identity";
import { findUserById, findUsersByName, getUserIdentities } from "@/be/users";
import {
  createToolRegistrar,
  type SwarmToolResult,
  swarmToolOutputSchema,
  toolOk,
} from "@/tools/utils";
import type { User } from "@/types";

// Loose mirror of UserSchema (+ externalIds) for tool output: every field
// optional, no datetime format pins.
const resolveUserOutputShape = z.looseObject({
  status: z.string().optional(),
  kind: z.string().optional(),
  externalId: z.string().optional(),
  candidates: z
    .array(
      z.looseObject({
        userId: z.string().optional(),
        name: z.string().optional(),
        email: z.string().optional(),
      }),
    )
    .optional(),
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
  createdAt: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
  externalIds: z
    .array(z.looseObject({ kind: z.string().optional(), externalId: z.string().optional() }))
    .optional(),
});

/**
 * `resolve-user` — the framework's provider-agnostic reverse lookup:
 *   - `{kind, externalId}` for platform-identity lookups. This is generic
 *     across every provider — `{kind: 'slack', externalId: 'U016H7XKZGS'}`,
 *     `{kind: 'linear', externalId: '<uuid>'}`, `{kind: 'github', externalId: 'octocat'}`,
 *     `{kind: 'gitlab', externalId: 'jdoe'}`, `{kind: 'jira', externalId: '<accountId>'}` —
 *     there are deliberately NO per-provider sugar keys (no `slackUserId`, no
 *     `githubUsername`); the shape is always the same pair.
 *   - `email` for primary-email or alias lookup.
 *   - `userId` for direct canonical-ID lookup (reverse-resolution: "give me
 *     all external IDs for this swarm user").
 *   - `name` for a human display-name search (convenience for forming a
 *     query, NOT an identity-stamping key) — exact match, or first-token
 *     prefix match. More than one match is ambiguous and is returned as
 *     candidates, never guessed.
 *
 * A lookup that matches nothing returns a structured `{status: "unknown", ...}`
 * payload (never prose) so callers and scripts can branch on it directly.
 *
 * Validator requires exactly one of: (kind + externalId), email, userId, name.
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
        "Identity kind — e.g. 'slack', 'linear', 'github', 'gitlab', 'jira', 'kapso', 'whatsapp', or a custom value. Must be paired with externalId.",
      ),
    externalId: z
      .string()
      .optional()
      .describe(
        "Platform-specific identifier for the given kind (e.g. Slack user ID 'U08NR6QD6CS', Linear user UUID, GitHub login, Jira accountId).",
      ),
    email: z.string().email().optional().describe("Email address (primary or alias)."),
    userId: z
      .string()
      .optional()
      .describe(
        "Canonical swarm user ID. Use this to reverse-look up all external identities for a known user (e.g. find their GitHub handle from a requestedByUserId).",
      ),
    name: z
      .string()
      .min(2)
      .optional()
      .describe(
        "Human display name to search for (exact, or first-token prefix). Convenience only — ambiguous matches return all candidates rather than picking one.",
      ),
  })
  .strict()
  .refine(
    (v) =>
      (v.kind !== undefined && v.externalId !== undefined) ||
      v.email !== undefined ||
      v.userId !== undefined ||
      v.name !== undefined,
    { message: "Provide either (kind + externalId), email, userId, or name" },
  );

function profileResult(user: User): SwarmToolResult {
  const externalIds = getUserIdentities(user.id);
  const payload = { ...user, externalIds };
  return toolOk(`Resolved user "${user.name}" (${user.id}).`, {
    details: JSON.stringify(payload, null, 2),
    data: payload,
  });
}

function unknownResult(kind: string, externalId: string): SwarmToolResult {
  return toolOk(`No user found for ${kind}="${externalId}".`, {
    data: { status: "unknown", kind, externalId },
  });
}

function ambiguousResult(candidates: User[]): SwarmToolResult {
  const candidateList = candidates.map((u) => ({ userId: u.id, name: u.name, email: u.email }));
  return toolOk(
    "AMBIGUOUS — do not pick by salience. Multiple users match this name; disambiguate with (kind, externalId), email, or userId.",
    {
      details: JSON.stringify(candidateList, null, 2),
      data: { status: "ambiguous", candidates: candidateList },
    },
  );
}

export const registerResolveUserTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "resolve-user",
    {
      title: "Resolve user identity",
      description:
        "Provider-agnostic reverse lookup: (kind, externalId) → user, e.g. {kind: 'slack', externalId: 'U016H7XKZGS'} or {kind: 'github', externalId: 'octocat'} — the same shape for every provider, no per-provider keys. Also accepts email (primary or alias), userId (reverse lookup of all linked identities), or name (exact/prefix search). A miss returns a structured {status: 'unknown', ...} payload, never prose; an ambiguous name search returns {status: 'ambiguous', candidates: [...]}.",
      annotations: { readOnlyHint: true },
      inputSchema: resolveUserInputSchema,
      outputSchema: swarmToolOutputSchema(resolveUserOutputShape.shape),
    },
    async ({ kind, externalId, email, userId, name }) => {
      if (kind && externalId) {
        const resolution = resolveIdentity(kind, externalId);
        if (resolution.status === "unknown") return unknownResult(kind, externalId);
        const user = findUserById(resolution.userId);
        if (!user) return unknownResult(kind, externalId);
        return profileResult(user);
      }

      if (email) {
        const resolution = resolveIdentityByEmail(email);
        if (resolution.status === "unknown") return unknownResult("email", email);
        const user = findUserById(resolution.userId);
        if (!user) return unknownResult("email", email);
        return profileResult(user);
      }

      if (userId) {
        const user = findUserById(userId);
        if (!user) return unknownResult("userId", userId);
        return profileResult(user);
      }

      // name is guaranteed set here — the schema refine requires one of the
      // four branches, and the three above are exhausted.
      const matches = findUsersByName(name ?? "");
      if (matches.length === 0) return unknownResult("name", name ?? "");
      const [only] = matches;
      if (matches.length === 1 && only) return profileResult(only);
      return ambiguousResult(matches);
    },
  );
};
