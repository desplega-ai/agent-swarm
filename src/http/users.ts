/**
 * Operator-facing HTTP surface for the People page + Unmapped triage.
 *
 * Every endpoint goes through the `route()` factory so OpenAPI picks it up
 * automatically (`scripts/generate-openapi.ts` imports this file). All
 * mutation paths read the operator's fingerprint via `getOperatorActor()` and
 * pass it as the `IdentityActor` arg to the helpers in `src/be/users.ts` — so
 * every identity mutation lands an event row tagged `op:<sha256-16>`.
 *
 * Endpoint set:
 *
 *   GET    /api/users
 *   POST   /api/users
 *   GET    /api/users/unmapped                       (must precede /:id)
 *   POST   /api/users/unmapped/:kind/:externalId/resolve
 *   GET    /api/users/:id
 *   PATCH  /api/users/:id
 *   POST   /api/users/:id/mcp-tokens
 *   DELETE /api/users/:id/mcp-tokens/:tokenId
 *   POST   /api/users/:id/merge
 *   GET    /api/users/:id/events
 *   POST   /api/users/:id/identities
 *   DELETE /api/users/:id/identities/:kind/:externalId
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createUser,
  deleteBudget,
  deleteKv,
  deleteUser,
  getAllUsers,
  getUserById,
  getUserIdentities,
  type IdentityEvent,
  linkIdentity,
  listKv,
  listUserEvents,
  listUserTokens,
  mintToken,
  recordIdentityEvent,
  revokeToken,
  unlinkIdentity,
  updateUser,
  upsertBudget,
} from "@swarm/storage";
import { z } from "zod";
import { getOperatorActor } from "./operator-actor";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Response composition ────────────────────────────────────────────────────

/**
 * Compose the full People-page row for a user: base profile + identities +
 * token summaries + the last N identity events. `recentEventLimit` defaults
 * to 5 to keep the list-view response bounded.
 */
function composeUser(userId: string, recentEventLimit = 5) {
  const user = getUserById(userId);
  if (!user) return null;
  return {
    ...user,
    identities: getUserIdentities(userId),
    tokens: listUserTokens(userId),
    recentEvents: listUserEvents(userId, { limit: recentEventLimit }),
  };
}

function syncUserBudgetMirror(userId: string, dailyBudgetUsd: number | null | undefined): void {
  if (dailyBudgetUsd === undefined) return;
  if (dailyBudgetUsd === null) {
    deleteBudget("user", userId);
    return;
  }
  upsertBudget("user", userId, dailyBudgetUsd);
}

// ─── Route Definitions ───────────────────────────────────────────────────────

const listUsers = route({
  method: "get",
  path: "/api/users",
  pattern: ["api", "users"],
  summary: "List all users with identities, token summaries and recent events",
  tags: ["Users"],
  query: z.object({
    recentEvents: z.coerce.number().int().min(0).max(50).optional(),
  }),
  responses: {
    200: { description: "List of users" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const createUserRoute = route({
  method: "post",
  path: "/api/users",
  pattern: ["api", "users"],
  summary: "Create a new user (optionally with initial identity links)",
  tags: ["Users"],
  body: z.object({
    name: z.string().min(1),
    email: z.string().optional(),
    role: z.string().optional(),
    notes: z.string().optional(),
    emailAliases: z.array(z.string()).optional(),
    preferredChannel: z.string().optional(),
    timezone: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    dailyBudgetUsd: z.number().nullable().optional(),
    status: z.enum(["invited", "active", "suspended"]).optional(),
    identities: z
      .array(z.object({ kind: z.string().min(1), externalId: z.string().min(1) }))
      .optional(),
  }),
  responses: {
    200: { description: "User created" },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const listUnmapped = route({
  method: "get",
  path: "/api/users/unmapped",
  pattern: ["api", "users", "unmapped"],
  summary: "List unmapped external identities (kv-backed triage queue)",
  tags: ["Users"],
  query: z.object({
    kind: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  }),
  responses: {
    200: { description: "List of unmapped identities sorted by count DESC, lastSeenAt DESC" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const resolveUnmapped = route({
  method: "post",
  path: "/api/users/unmapped/{kind}/{externalId}/resolve",
  pattern: ["api", "users", "unmapped", null, null, "resolve"],
  summary: "Resolve an unmapped identity — link to an existing user or create a new one",
  tags: ["Users"],
  params: z.object({ kind: z.string(), externalId: z.string() }),
  body: z.union([
    z.object({ userId: z.string().min(1) }),
    z.object({
      name: z.string().min(1),
      email: z.string().email().optional(),
      notes: z.string().optional(),
    }),
  ]),
  responses: {
    200: { description: "Identity linked + kv entries cleared" },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
    404: { description: "Target user not found" },
  },
  auth: { apiKey: true },
});

const getUserRoute = route({
  method: "get",
  path: "/api/users/{id}",
  pattern: ["api", "users", null],
  summary: "Get a user by ID with identities, token summaries and recent events",
  tags: ["Users"],
  params: z.object({ id: z.string() }),
  query: z.object({
    recentEvents: z.coerce.number().int().min(0).max(200).optional(),
  }),
  responses: {
    200: { description: "User row" },
    401: { description: "Unauthorized" },
    404: { description: "User not found" },
  },
  auth: { apiKey: true },
});

const updateUserRoute = route({
  method: "patch",
  path: "/api/users/{id}",
  pattern: ["api", "users", null],
  summary: "Update an existing user (profile / budget / status / email-aliases / identities)",
  tags: ["Users"],
  params: z.object({ id: z.string() }),
  body: z
    .object({
      name: z.string().min(1).optional(),
      email: z.string().optional(),
      role: z.string().optional(),
      notes: z.string().optional(),
      emailAliases: z.array(z.string()).optional(),
      preferredChannel: z.string().optional(),
      timezone: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
      dailyBudgetUsd: z.number().nullable().optional(),
      status: z.enum(["invited", "active", "suspended"]).optional(),
      // Complete-list diff: passing this replaces the user's identity set,
      // emitting `identity_added` / `identity_removed` for each delta.
      identities: z
        .array(z.object({ kind: z.string().min(1), externalId: z.string().min(1) }))
        .optional(),
    })
    .refine((v) => Object.keys(v).length > 0, {
      message: "At least one field must be provided",
    }),
  responses: {
    200: { description: "User updated" },
    400: { description: "Validation error or empty body" },
    401: { description: "Unauthorized" },
    404: { description: "User not found" },
  },
  auth: { apiKey: true },
});

const mintUserMcpTokenRoute = route({
  method: "post",
  path: "/api/users/{id}/mcp-tokens",
  pattern: ["api", "users", null, "mcp-tokens"],
  summary: "Mint a one-time plaintext MCP token for a user",
  description:
    "Returns the plaintext token exactly once. Subsequent reads only expose token summaries.",
  tags: ["Users"],
  params: z.object({ id: z.string() }),
  body: z.object({
    label: z.string().nullable().optional(),
  }),
  responses: {
    200: { description: "Minted token plaintext, token summary and composed user" },
    401: { description: "Unauthorized" },
    404: { description: "User not found" },
  },
  auth: { apiKey: true },
});

const revokeUserMcpTokenRoute = route({
  method: "delete",
  path: "/api/users/{id}/mcp-tokens/{tokenId}",
  pattern: ["api", "users", null, "mcp-tokens", null],
  summary: "Revoke a user's MCP token",
  tags: ["Users"],
  params: z.object({ id: z.string(), tokenId: z.string() }),
  responses: {
    200: { description: "Composed user after token revocation" },
    401: { description: "Unauthorized" },
    404: { description: "User or token not found" },
  },
  auth: { apiKey: true },
});

const mergeUsersRoute = route({
  method: "post",
  path: "/api/users/{id}/merge",
  pattern: ["api", "users", null, "merge"],
  summary: "Merge another user into this one — moves identities + email aliases, deletes source",
  tags: ["Users"],
  params: z.object({ id: z.string() }),
  body: z.object({ sourceUserId: z.string().min(1) }),
  responses: {
    200: { description: "Merged user" },
    400: { description: "Validation error (e.g. target == source)" },
    401: { description: "Unauthorized" },
    404: { description: "Target or source user not found" },
  },
  auth: { apiKey: true },
});

const listEventsRoute = route({
  method: "get",
  path: "/api/users/{id}/events",
  pattern: ["api", "users", null, "events"],
  summary: "Paginated identity-event timeline for a user (DESC by createdAt)",
  tags: ["Users"],
  params: z.object({ id: z.string() }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    before: z.string().optional(),
  }),
  responses: {
    200: { description: "Array of identity events" },
    401: { description: "Unauthorized" },
    404: { description: "User not found" },
  },
  auth: { apiKey: true },
});

const addIdentityRoute = route({
  method: "post",
  path: "/api/users/{id}/identities",
  pattern: ["api", "users", null, "identities"],
  summary: "Link a new (kind, externalId) identity to this user",
  tags: ["Users"],
  params: z.object({ id: z.string() }),
  body: z.object({ kind: z.string().min(1), externalId: z.string().min(1) }),
  responses: {
    200: { description: "Updated identity list" },
    400: { description: "Validation error or PK collision" },
    401: { description: "Unauthorized" },
    404: { description: "User not found" },
  },
  auth: { apiKey: true },
});

const deleteIdentityRoute = route({
  method: "delete",
  path: "/api/users/{id}/identities/{kind}/{externalId}",
  pattern: ["api", "users", null, "identities", null, null],
  summary: "Remove a (kind, externalId) identity link from this user",
  tags: ["Users"],
  params: z.object({ id: z.string(), kind: z.string(), externalId: z.string() }),
  responses: {
    200: { description: "Updated identity list" },
    401: { description: "Unauthorized" },
    404: { description: "User not found" },
  },
  auth: { apiKey: true },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const UNMAPPED_KINDS = ["slack", "github", "gitlab", "linear", "kapso"] as const;

/**
 * Group the two-key-per-identity kv entries (`<externalId>:meta` json +
 * `<externalId>:count` integer) under a single `externalId` and return a
 * unified shape ready for the People-page Unmapped tab.
 */
function collectUnmappedForKind(kind: string, limit: number) {
  const namespace = `integration:unmapped:${kind}`;
  // listKv is bounded internally; we ask for 2x the cap so meta+count pairs
  // produce up to `limit` unique externalIds.
  const rows = listKv(namespace, { limit: Math.min(limit * 2, 1000), offset: 0 });
  const byId = new Map<
    string,
    {
      kind: string;
      externalId: string;
      lastSeenAt: string | null;
      count: number;
      sampleEventType: string | null;
      sampleContext: unknown | null;
    }
  >();
  for (const row of rows) {
    const key = row.key;
    let suffix: "meta" | "count" | null = null;
    let externalId = "";
    if (key.endsWith(":meta")) {
      suffix = "meta";
      externalId = key.slice(0, -":meta".length);
    } else if (key.endsWith(":count")) {
      suffix = "count";
      externalId = key.slice(0, -":count".length);
    } else {
      // Legacy/unknown shape — skip.
      continue;
    }
    let entry = byId.get(externalId);
    if (!entry) {
      entry = {
        kind,
        externalId,
        lastSeenAt: null,
        count: 0,
        sampleEventType: null,
        sampleContext: null,
      };
      byId.set(externalId, entry);
    }
    if (suffix === "meta") {
      // Meta payload shape is producer-defined; we pull the common fields.
      const meta =
        row.value && typeof row.value === "object" ? (row.value as Record<string, unknown>) : null;
      if (meta) {
        const lastSeenAt = meta.lastSeenAt;
        if (typeof lastSeenAt === "string") entry.lastSeenAt = lastSeenAt;
        const sampleEventType = meta.sampleEventType ?? meta.eventType;
        if (typeof sampleEventType === "string") entry.sampleEventType = sampleEventType;
        entry.sampleContext = meta.sampleContext ?? meta.context ?? null;
      }
    } else {
      // Count is stored as integer (decoded by listKv into a number); coerce.
      const n = typeof row.value === "number" ? row.value : Number(row.value);
      if (Number.isFinite(n)) entry.count = n;
    }
  }
  return Array.from(byId.values());
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleUsers(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  // ─── GET /api/users ────────────────────────────────────────────────────────
  if (listUsers.match(req.method, pathSegments)) {
    const parsed = await listUsers.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const recentLimit = parsed.query.recentEvents ?? 5;
    const users = getAllUsers().map((u) => composeUser(u.id, recentLimit));
    json(res, { users });
    return true;
  }

  // ─── POST /api/users ───────────────────────────────────────────────────────
  if (createUserRoute.match(req.method, pathSegments)) {
    const parsed = await createUserRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = getOperatorActor(req, res);
    if (!actor) return true;

    try {
      const { identities, ...userFields } = parsed.body;
      const user = createUser(userFields);
      syncUserBudgetMirror(user.id, userFields.dailyBudgetUsd);
      for (const ident of identities ?? []) {
        linkIdentity(user.id, ident.kind, ident.externalId, actor);
      }
      if (userFields.dailyBudgetUsd !== undefined) {
        recordIdentityEvent(user.id, "budget_changed", actor, null, {
          dailyBudgetUsd: userFields.dailyBudgetUsd,
        });
      }
      const composed = composeUser(user.id);
      json(res, { user: composed });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to create user", 500);
    }
    return true;
  }

  // ─── GET /api/users/unmapped ───────────────────────────────────────────────
  // MUST be checked before /api/users/:id — same depth so first-match wins.
  if (listUnmapped.match(req.method, pathSegments)) {
    const parsed = await listUnmapped.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const limit = parsed.query.limit ?? 100;
    const kinds = parsed.query.kind ? [parsed.query.kind] : UNMAPPED_KINDS;
    const rows = kinds.flatMap((k) => collectUnmappedForKind(k, limit));
    rows.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      const al = a.lastSeenAt ?? "";
      const bl = b.lastSeenAt ?? "";
      return bl.localeCompare(al);
    });
    json(res, { unmapped: rows.slice(0, limit) });
    return true;
  }

  // ─── POST /api/users/unmapped/:kind/:externalId/resolve ───────────────────
  if (resolveUnmapped.match(req.method, pathSegments)) {
    const parsed = await resolveUnmapped.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = getOperatorActor(req, res);
    if (!actor) return true;

    // Path params arrive URL-encoded — decode so externalIds with `@`, `+`, `:`
    // etc. (AgentMail email-as-externalId, "@handle" Linear usernames) AND
    // custom kinds containing `;`, `@`, `+` land both in user_external_ids and
    // kv-delete with their real value.
    const kind = decodeURIComponent(parsed.params.kind);
    const externalId = decodeURIComponent(parsed.params.externalId);
    try {
      let targetUserId: string;
      if ("userId" in parsed.body) {
        const existing = getUserById(parsed.body.userId);
        if (!existing) {
          jsonError(res, "Target user not found", 404);
          return true;
        }
        targetUserId = existing.id;
      } else {
        const created = createUser({
          name: parsed.body.name,
          email: parsed.body.email,
          notes: parsed.body.notes,
        });
        targetUserId = created.id;
      }
      linkIdentity(targetUserId, kind, externalId, actor);
      // Clear both kv rows (best-effort — DELETE is idempotent).
      const ns = `integration:unmapped:${kind}`;
      deleteKv(ns, `${externalId}:meta`);
      deleteKv(ns, `${externalId}:count`);
      const user = composeUser(targetUserId);
      json(res, { user });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to resolve unmapped", 500);
    }
    return true;
  }

  // ─── GET /api/users/:id/events ─────────────────────────────────────────────
  if (listEventsRoute.match(req.method, pathSegments)) {
    const parsed = await listEventsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!getUserById(parsed.params.id)) {
      jsonError(res, "User not found", 404);
      return true;
    }
    const events: IdentityEvent[] = listUserEvents(parsed.params.id, {
      limit: parsed.query.limit,
      before: parsed.query.before,
    });
    json(res, { events });
    return true;
  }

  // ─── POST /api/users/:id/mcp-tokens ───────────────────────────────────────
  if (mintUserMcpTokenRoute.match(req.method, pathSegments)) {
    const parsed = await mintUserMcpTokenRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = getOperatorActor(req, res);
    if (!actor) return true;
    if (!getUserById(parsed.params.id)) {
      jsonError(res, "User not found", 404);
      return true;
    }

    try {
      const { tokenId, plaintext } = mintToken(parsed.params.id, parsed.body.label ?? null, actor);
      const token = listUserTokens(parsed.params.id).find((t) => t.id === tokenId);
      json(res, { plaintext, token, user: composeUser(parsed.params.id) });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to mint token", 500);
    }
    return true;
  }

  // ─── DELETE /api/users/:id/mcp-tokens/:tokenId ────────────────────────────
  if (revokeUserMcpTokenRoute.match(req.method, pathSegments)) {
    const parsed = await revokeUserMcpTokenRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = getOperatorActor(req, res);
    if (!actor) return true;
    if (!getUserById(parsed.params.id)) {
      jsonError(res, "User not found", 404);
      return true;
    }

    const tokenBelongsToUser = listUserTokens(parsed.params.id).some(
      (token) => token.id === parsed.params.tokenId,
    );
    if (!tokenBelongsToUser) {
      jsonError(res, "Token not found", 404);
      return true;
    }

    try {
      revokeToken(parsed.params.tokenId, actor);
      json(res, { user: composeUser(parsed.params.id) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to revoke token";
      if (message.includes("Token not found")) {
        jsonError(res, "Token not found", 404);
      } else {
        jsonError(res, message, 500);
      }
    }
    return true;
  }

  // ─── POST /api/users/:id/identities ────────────────────────────────────────
  if (addIdentityRoute.match(req.method, pathSegments)) {
    const parsed = await addIdentityRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = getOperatorActor(req, res);
    if (!actor) return true;
    if (!getUserById(parsed.params.id)) {
      jsonError(res, "User not found", 404);
      return true;
    }
    try {
      linkIdentity(parsed.params.id, parsed.body.kind, parsed.body.externalId, actor);
      json(res, { identities: getUserIdentities(parsed.params.id) });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to link identity", 400);
    }
    return true;
  }

  // ─── DELETE /api/users/:id/identities/:kind/:externalId ────────────────────
  if (deleteIdentityRoute.match(req.method, pathSegments)) {
    const parsed = await deleteIdentityRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = getOperatorActor(req, res);
    if (!actor) return true;
    if (!getUserById(parsed.params.id)) {
      jsonError(res, "User not found", 404);
      return true;
    }
    try {
      // Path params arrive URL-encoded — decode so a stored `@handle` /
      // email-as-externalId AND a custom kind with `;`, `@`, `+` can actually
      // be unlinked from the UI.
      const kind = decodeURIComponent(parsed.params.kind);
      const externalId = decodeURIComponent(parsed.params.externalId);
      unlinkIdentity(parsed.params.id, kind, externalId, actor);
      json(res, { identities: getUserIdentities(parsed.params.id) });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to unlink identity", 500);
    }
    return true;
  }

  // ─── POST /api/users/:id/merge ─────────────────────────────────────────────
  if (mergeUsersRoute.match(req.method, pathSegments)) {
    const parsed = await mergeUsersRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = getOperatorActor(req, res);
    if (!actor) return true;

    const targetId = parsed.params.id;
    const sourceId = parsed.body.sourceUserId;
    if (targetId === sourceId) {
      jsonError(res, "Cannot merge a user into itself", 400);
      return true;
    }
    const targetBefore = composeUser(targetId);
    const sourceBefore = composeUser(sourceId);
    if (!targetBefore) {
      jsonError(res, "Target user not found", 404);
      return true;
    }
    if (!sourceBefore) {
      jsonError(res, "Source user not found", 404);
      return true;
    }

    try {
      // Move every identity from source → target.
      for (const ident of sourceBefore.identities) {
        unlinkIdentity(sourceId, ident.kind, ident.externalId, actor);
        linkIdentity(targetId, ident.kind, ident.externalId, actor);
      }

      // Merge email aliases — append source.email + source.emailAliases into
      // target.emailAliases (de-duped). Emit `email_added` per added alias.
      const targetAliases = new Set(targetBefore.emailAliases ?? []);
      const targetPrimary = (targetBefore.email ?? "").toLowerCase();
      const newAliases: string[] = [];
      const candidates = [
        ...(sourceBefore.email ? [sourceBefore.email] : []),
        ...(sourceBefore.emailAliases ?? []),
      ];
      for (const candidate of candidates) {
        const lower = candidate.toLowerCase();
        if (!lower || lower === targetPrimary) continue;
        if (
          ![...targetAliases].some((a) => a.toLowerCase() === lower) &&
          !newAliases.some((a) => a.toLowerCase() === lower)
        ) {
          newAliases.push(candidate);
        }
      }
      if (newAliases.length > 0) {
        const merged = [...(targetBefore.emailAliases ?? []), ...newAliases];
        updateUser(targetId, { emailAliases: merged });
        for (const alias of newAliases) {
          recordIdentityEvent(targetId, "email_added", actor, null, { email: alias });
        }
      }

      // Delete source — CASCADE cleans up any leftover external_ids row that
      // we may have missed (and clears tasks.requestedByUserId pointers).
      deleteUser(sourceId);

      // Single manual_merge event on target capturing the before/after rows.
      // The source row is deleted above, so carry a minimal snapshot of the
      // source user ({id, name, email}) inside the `after` payload under
      // `source` — this lets the UI render "Merged manually from X → Y".
      const targetAfter = composeUser(targetId);
      recordIdentityEvent(targetId, "manual_merge", actor, targetBefore, {
        ...targetAfter,
        source: {
          id: sourceBefore.id,
          name: sourceBefore.name,
          email: sourceBefore.email,
        },
      });

      // Re-compose AFTER the event so the response surfaces the merge event in
      // recentEvents (otherwise the timeline is missing the event we just wrote).
      json(res, { user: composeUser(targetId) });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to merge users", 500);
    }
    return true;
  }

  // ─── GET /api/users/:id ────────────────────────────────────────────────────
  if (getUserRoute.match(req.method, pathSegments)) {
    const parsed = await getUserRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const composed = composeUser(parsed.params.id, parsed.query.recentEvents ?? 50);
    if (!composed) {
      jsonError(res, "User not found", 404);
      return true;
    }
    json(res, { user: composed });
    return true;
  }

  // ─── PATCH /api/users/:id ──────────────────────────────────────────────────
  if (updateUserRoute.match(req.method, pathSegments)) {
    const parsed = await updateUserRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = getOperatorActor(req, res);
    if (!actor) return true;

    const before = getUserById(parsed.params.id);
    if (!before) {
      jsonError(res, "User not found", 404);
      return true;
    }

    try {
      const { identities, metadata, ...rest } = parsed.body;
      // updateUser doesn't accept `metadata: null` directly — passthrough via cast.
      const update: Parameters<typeof updateUser>[1] = { ...rest };
      if (metadata !== undefined) {
        update.metadata = metadata as Record<string, unknown> | null;
      }
      const updated = updateUser(parsed.params.id, update);
      if (!updated) {
        jsonError(res, "User not found", 404);
        return true;
      }
      syncUserBudgetMirror(parsed.params.id, parsed.body.dailyBudgetUsd);

      // Budget event
      if (
        parsed.body.dailyBudgetUsd !== undefined &&
        (before.dailyBudgetUsd ?? null) !== (parsed.body.dailyBudgetUsd ?? null)
      ) {
        recordIdentityEvent(
          parsed.params.id,
          "budget_changed",
          actor,
          { dailyBudgetUsd: before.dailyBudgetUsd ?? null },
          { dailyBudgetUsd: parsed.body.dailyBudgetUsd ?? null },
        );
      }

      // Status event
      if (parsed.body.status !== undefined && before.status !== parsed.body.status) {
        recordIdentityEvent(
          parsed.params.id,
          "status_changed",
          actor,
          { status: before.status },
          { status: parsed.body.status },
        );
      }

      // Email aliases diff — emit email_added / email_removed per Q19
      if (parsed.body.emailAliases !== undefined) {
        const beforeSet = new Set((before.emailAliases ?? []).map((a) => a.toLowerCase()));
        const afterSet = new Set(parsed.body.emailAliases.map((a) => a.toLowerCase()));
        for (const a of parsed.body.emailAliases) {
          if (!beforeSet.has(a.toLowerCase())) {
            recordIdentityEvent(parsed.params.id, "email_added", actor, null, { email: a });
          }
        }
        for (const a of before.emailAliases ?? []) {
          if (!afterSet.has(a.toLowerCase())) {
            recordIdentityEvent(parsed.params.id, "email_removed", actor, { email: a }, null);
          }
        }
      }

      // Profile-field diffs — emit one `profile_changed` event per field that
      // changed value. Status / budget / aliases / identities already emit
      // their own dedicated events above; skip them here to avoid double-emit.
      const PROFILE_FIELDS = [
        "name",
        "email",
        "role",
        "timezone",
        "preferredChannel",
        "notes",
        "metadata",
      ] as const;
      for (const field of PROFILE_FIELDS) {
        if (parsed.body[field] === undefined) continue;
        const beforeVal = (before as unknown as Record<string, unknown>)[field] ?? null;
        const afterVal = parsed.body[field] ?? null;
        // Cheap deep-equal via JSON — fields are scalar strings or object/null.
        if (JSON.stringify(beforeVal) === JSON.stringify(afterVal)) continue;
        recordIdentityEvent(
          parsed.params.id,
          "profile_changed",
          actor,
          { [field]: beforeVal },
          { [field]: afterVal },
        );
      }

      // Identities diff — complete-list semantics. linkIdentity / unlinkIdentity
      // already emit the right event each.
      if (identities !== undefined) {
        const beforeIds = getUserIdentities(parsed.params.id);
        const beforeKeys = new Set(beforeIds.map((i) => `${i.kind}:${i.externalId}`));
        const afterKeys = new Set(identities.map((i) => `${i.kind}:${i.externalId}`));
        for (const i of identities) {
          if (!beforeKeys.has(`${i.kind}:${i.externalId}`)) {
            linkIdentity(parsed.params.id, i.kind, i.externalId, actor);
          }
        }
        for (const i of beforeIds) {
          if (!afterKeys.has(`${i.kind}:${i.externalId}`)) {
            unlinkIdentity(parsed.params.id, i.kind, i.externalId, actor);
          }
        }
      }

      const composed = composeUser(parsed.params.id);
      json(res, { user: composed });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to update user", 500);
    }
    return true;
  }

  return false;
}
