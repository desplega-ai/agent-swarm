/**
 * Canonical API-side identity surface — the only path that mutates identity
 * tables. Every mutating helper wraps row mutation + event emission in a
 * single `getStorage().transaction()` so the invariant "every identity
 * mutation has a matching event row" (Q9) holds even on partial failures.
 *
 * This module is API-side ONLY. The DB-boundary checker (`scripts/check-db-boundary.sh`)
 * enforces that worker-side code paths (`src/commands/`, `src/hooks/`,
 * `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`) do not
 * import from `src/be/*`. This file follows that convention.
 *
 * Q-research refs (brainstorm 2026-05-18-humans-as-first-class-users):
 *   * Q10  — helper surface (find/findOrCreate/link/unlink/mint/revoke/resolve)
 *   * Q17.G — `getUserIdentities` for People-page response composition
 *   * Q19  — full event-type CHECK enum (mirrored in `src/types.ts` + migration 064)
 *   * Q20  — `mintToken` returns `aswt_<base62>`, stores hash + 4-char preview
 *   * Q12  — `findUserByEmail` checks BOTH primary email AND emailAliases
 *   * Q14  — PK collision on duplicate `(kind, externalId)` throws (no UNIQUE fallback)
 *   * Q16  — `fingerprintApiKey` returns `op:<sha256-16>` for operator audit
 */

import { createHash, randomUUID } from "node:crypto";
import type { IdentityEventRow, UserRow } from "@desplega/storage";
import { scheduleOrgDomainRecompute } from "../telemetry-identity";
import type { User } from "../types";
import type { ScriptRunProvenance } from "../utils/request-auth-context";
import { registerVolatileSecret, unregisterVolatileSecret } from "../utils/secret-scrubber";
import { closeSessionTokenConnections } from "../utils/session-token-connections";
import { randomChars } from "../utils/short-id";
import { getStorage } from "./storage";
import { validateRuntimeTokenTtlHours } from "./swarm-config-guard";

const usersRepo = () => getStorage().repos.users;
const sessionsRepo = () => getStorage().repos.sessions;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Caller identity for event auditing. Embedded into `user_identity_events.actor`
 * as `<kind>:<id>`. The migration's CHECK constraint does NOT validate `actor`
 * shape — it's free-form per Q19 — but helpers stick to this convention so
 * UI filters can carve by kind cheaply.
 */
export type IdentityActor = {
  kind: "system" | "operator" | "user";
  id: string;
  /**
   * For a user actor: the `user_tokens` row the request authenticated with.
   * Unset for a page session. Not recorded in events.
   */
  tokenId?: string;
};

function actorString(actor: IdentityActor): string {
  return `${actor.kind}:${actor.id}`;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? undefined,
    role: row.role ?? undefined,
    notes: row.notes ?? undefined,
    emailAliases: row.emailAliases ? (JSON.parse(row.emailAliases) as string[]) : [],
    preferredChannel: row.preferredChannel ?? "slack",
    timezone: row.timezone ?? undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    dailyBudgetUsd: row.dailyBudgetUsd ?? null,
    status: (row.status as "invited" | "active" | "suspended") ?? "active",
    ...(row.mergedIntoUserId ? { mergedIntoUserId: row.mergedIntoUserId } : {}),
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** Single SELECT by primary key. */
export async function findUserById(id: string): Promise<User | null> {
  const row = await usersRepo().findUserById(id);
  return row ? rowToUser(row) : null;
}

/**
 * A user whose merge job still runs (`users.mergedIntoUserId` set) is the
 * target for every identity lookup: the merge route already moved its
 * identities and aliases, and the background job only rewrites attribution
 * before it deletes the row. Lookups by id are left alone so the People page
 * and the job itself still see the source row.
 */
async function followMergedUser(row: UserRow): Promise<User | null> {
  if (!row.mergedIntoUserId) return rowToUser(row);
  const target = await usersRepo().findUserById(row.mergedIntoUserId);
  return target ? rowToUser(target) : null;
}

/**
 * Look up a user by an `(kind, externalId)` pair via `user_external_ids`.
 * Returns null if no mapping exists. Use this for webhook auto-link paths.
 */
export async function findUserByExternalId(kind: string, externalId: string): Promise<User | null> {
  const row = await usersRepo().findUserByExternalId(kind, externalId);
  return row ? followMergedUser(row) : null;
}

/**
 * Find by email — primary `users.email` OR a member of `emailAliases` (JSON
 * array, case-insensitive). Q12 invariant: aliases are first-class.
 *
 * NOTE: SQLite's `json_each` requires a non-null source; we filter on
 * `emailAliases != '[]'` in the alias branch so the rare row with NULL
 * aliases doesn't blow up the JOIN.
 */
export async function findUserByEmail(email: string): Promise<User | null> {
  const lower = email.toLowerCase();

  // Primary email (case-insensitive). A merge source keeps its primary email
  // until the job deletes it, while the target already holds it as an alias,
  // so the source row must not win here.
  const primary = await usersRepo().findUserByPrimaryEmail(email);
  if (primary) return rowToUser(primary);

  // Alias array
  const aliasRows = await usersRepo().listUsersWithEmailAliases();
  for (const r of aliasRows) {
    const aliases: string[] = r.emailAliases ? (JSON.parse(r.emailAliases) as string[]) : [];
    if (aliases.some((a) => a.toLowerCase() === lower)) {
      return rowToUser(r);
    }
  }
  return null;
}

/**
 * Look up users by display name — exact match (case-insensitive) first;
 * falls back to a first-token prefix match (e.g. "Alberto" matches both
 * "Alberto Maurel" and "Alberto Dubois"). Deterministic, no fuzzy matching:
 * `resolve-user`'s name lookup treats more than one match as ambiguous
 * rather than guessing.
 */
export async function findUsersByName(name: string): Promise<User[]> {
  const trimmed = name.trim();
  if (!trimmed) return [];

  // A merge source (mergedIntoUserId set) is on its way out; its target is
  // found by its own name.
  const exact = await usersRepo().listUsersByName(trimmed);
  if (exact.length > 0) return exact.map(rowToUser);

  const firstToken = trimmed.split(/\s+/)[0] ?? trimmed;
  const prefixed = await usersRepo().listUsersByNamePrefix(firstToken);
  return prefixed.map(rowToUser);
}

/**
 * Return all `(kind, externalId)` mappings for a user — used by the People
 * page detail view to render identity badges in one request.
 */
export async function getUserIdentities(
  userId: string,
): Promise<Array<{ kind: string; externalId: string }>> {
  return usersRepo().listExternalIds(userId);
}

/**
 * Identity-event row shape — what the People page timeline consumes. Mirrors
 * the columns on `user_identity_events`; `beforeJson`/`afterJson` are decoded
 * here so callers don't repeat the parse.
 */
export type IdentityEvent = {
  id: string;
  userId: string;
  eventType: string;
  actor: string;
  before: unknown | null;
  after: unknown | null;
  createdAt: string;
};

function rowToEvent(row: IdentityEventRow): IdentityEvent {
  return {
    id: row.id,
    userId: row.userId,
    eventType: row.eventType,
    actor: row.actor,
    before: row.beforeJson == null ? null : (JSON.parse(row.beforeJson) as unknown),
    after: row.afterJson == null ? null : (JSON.parse(row.afterJson) as unknown),
    createdAt: row.createdAt,
  };
}

/**
 * Paginated event timeline for a user. `limit` is hard-capped at 200 and a
 * limit of 0 returns no events (negatives clamp to 0); `before` is a cursor on
 * `createdAt` (ISO string) so the caller can keep paging by passing back the
 * last event's `createdAt`.
 */
export async function listUserEvents(
  userId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<IdentityEvent[]> {
  const limit = Math.max(0, Math.min(opts.limit ?? 50, 200));
  if (limit === 0) return [];
  const rows = await usersRepo().listIdentityEvents(userId, {
    before: opts.before ? opts.before : null,
    limit,
  });
  return rows.map(rowToEvent);
}

/**
 * Token row shape returned to operators — `tokenHash` is never exposed,
 * `tokenPreview` is the last 4 chars of the plaintext.
 */
export type UserTokenSummary = {
  id: string;
  userId: string;
  label: string | null;
  tokenPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/**
 * List a user's MCP tokens (without the hash). Used to render the People
 * page token panel — the mint/revoke endpoints + UI dialog ship with the
 * MCP-token plan, this helper lands here so step-8's `GET /users` response
 * can include token summaries.
 */
export async function listUserTokens(userId: string): Promise<UserTokenSummary[]> {
  return usersRepo().listUserTokens(userId);
}

// ---------------------------------------------------------------------------
// Event audit
// ---------------------------------------------------------------------------

/**
 * Append a row to `user_identity_events`. Exported so the manage-user MCP
 * tool / HTTP endpoint can emit `email_added` / `email_removed` /
 * `budget_changed` / `status_changed` directly (the mutating helpers below
 * already emit their own events in-transaction).
 */
export async function recordIdentityEvent(
  userId: string,
  eventType:
    | "auto_merge"
    | "manual_merge"
    | "identity_added"
    | "identity_removed"
    | "email_added"
    | "email_removed"
    | "token_minted"
    | "token_revoked"
    | "budget_changed"
    | "status_changed"
    | "profile_changed",
  actor: IdentityActor,
  before: unknown | null,
  after: unknown | null,
): Promise<void> {
  await usersRepo().insertIdentityEvent({
    id: randomUUID().replace(/-/g, ""),
    userId,
    eventType,
    actor: actorString(actor),
    beforeJson: before == null ? null : JSON.stringify(before),
    afterJson: after == null ? null : JSON.stringify(after),
    createdAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// findOrCreate
// ---------------------------------------------------------------------------

/**
 * Q4/Q5 auto-merge or auto-create by email.
 *
 * - If a user with this email (primary OR alias) exists, return it with
 *   `created: false` and emit an `auto_merge` event tagged with `hints`.
 * - Otherwise create a new row with `name` from hints (or the email
 *   local-part) and emit `identity_added` with the new row in `afterJson`.
 *
 * Only the create branch is wrapped in `getStorage().transaction()` so the
 * new row + its event land together; the `findUserByEmail` read and the
 * `auto_merge` event above it run outside any transaction.
 */
export async function findOrCreateUserByEmail(
  email: string,
  hints: { name?: string; role?: string; notes?: string; preferredChannel?: string },
  actor: IdentityActor,
): Promise<{ user: User; created: boolean }> {
  const existing = await findUserByEmail(email);
  if (existing) {
    await recordIdentityEvent(existing.id, "auto_merge", actor, null, { email, hints });
    return { user: existing, created: false };
  }

  const id = randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const name = hints.name?.trim() || email.split("@")[0] || email;

  const storage = getStorage();
  const created = await storage.transaction(async () => {
    const row = await usersRepo().insertUser({
      id,
      name,
      email,
      role: hints.role ?? null,
      notes: hints.notes ?? null,
      emailAliases: "[]",
      preferredChannel: hints.preferredChannel ?? "slack",
      timezone: null,
      metadata: null,
      dailyBudgetUsd: null,
      status: "active",
      avatar: null,
      now,
    });
    if (!row) throw new Error("Failed to create user");
    await recordIdentityEvent(id, "identity_added", actor, null, { email, name });
    return rowToUser(row);
  });
  // The org's email domain may come from this user (debounced, post-commit).
  storage.afterCommit(scheduleOrgDomainRecompute);

  return { user: created, created: true };
}

/**
 * Mark `sourceId` as merged into `targetId`: from then on identity lookups
 * resolve to the target and the source can no longer authenticate.
 */
export async function markUserMergedInto(sourceId: string, targetId: string): Promise<void> {
  await usersRepo().markUserMergedInto(sourceId, targetId, new Date().toISOString());
}

/** A profile lookup can finish after a manual edit. Test the stored value in the write. */
export async function fillMissingUserTimezone(id: string, timezone: string): Promise<void> {
  await usersRepo().fillMissingTimezone(id, timezone, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Identity link/unlink
// ---------------------------------------------------------------------------

/**
 * Map an external identity to a user. PK collision on `(kind, externalId)`
 * throws (Q14 — replaces old UNIQUE-constraint behaviour). Caller decides
 * whether to surface that as a merge prompt.
 *
 * Atomic: INSERT + event in one transaction.
 */
export async function linkIdentity(
  userId: string,
  kind: string,
  externalId: string,
  actor: IdentityActor,
): Promise<void> {
  await getStorage().transaction(async () => {
    await usersRepo().insertExternalId(userId, kind, externalId);
    await recordIdentityEvent(userId, "identity_added", actor, null, { kind, externalId });
  });
}

/**
 * Remove an `(kind, externalId)` mapping. No-op if no row matched — but we
 * still emit the event with the same before/after for the audit trail.
 * Atomic: DELETE + event in one transaction.
 */
export async function unlinkIdentity(
  userId: string,
  kind: string,
  externalId: string,
  actor: IdentityActor,
): Promise<void> {
  await getStorage().transaction(async () => {
    await usersRepo().deleteExternalId(userId, kind, externalId);
    await recordIdentityEvent(userId, "identity_removed", actor, { kind, externalId }, null);
  });
}

// ---------------------------------------------------------------------------
// Tokens — schema + helpers land here (Q20). Mint/revoke endpoints + UI
// dialog ship with the separate MCP-token plan.
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = "aswt_"; // agent-swarm-token

// base62 alphabet for URL-safe, unambiguous tokens.
const TOKEN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Generate an `aswt_<base62-24>` plaintext token, store its sha256 hash
 * plus the last-4-char preview, and emit `token_minted`. Returns the
 * plaintext ONCE; future reads only ever see the hash + preview.
 *
 * Token shape: `aswt_` + 24 base62 chars = >140 bits of entropy.
 */
export async function mintToken(
  userId: string,
  label: string | null,
  actor: IdentityActor,
  options: { source?: string } = {},
): Promise<{ tokenId: string; plaintext: string }> {
  // 24 uniformly random base62 chars (~143 bits of entropy).
  const plaintext = `${TOKEN_PREFIX}${randomChars(TOKEN_ALPHABET, 24)}`;
  const tokenId = randomUUID().replace(/-/g, "");
  const hash = sha256Hex(plaintext);
  const preview = plaintext.slice(-4);
  const now = new Date().toISOString();

  await getStorage().transaction(async () => {
    await usersRepo().insertUserToken({
      id: tokenId,
      userId,
      label,
      tokenHash: hash,
      tokenPreview: preview,
      createdAt: now,
      expiresAt: null,
    });
    await recordIdentityEvent(userId, "token_minted", actor, null, {
      tokenId,
      label,
      preview,
      ...(options.source ? { source: options.source } : {}),
    });
  });

  return { tokenId, plaintext };
}

/**
 * Mint the short-lived `aswt_` token a user MCP script run presents on its
 * `ctx.swarm` calls, so the script can do only what the requesting user's own
 * token can. It expires at `now + ttlMs` (the backstop for a run that dies
 * without revoking) and stays off the People page token list. No identity
 * event: one per run would flood the audit log, like `mintScriptRunToken`.
 */
export async function mintUserScriptRunToken(
  userId: string,
  ttlMs: number,
): Promise<{ tokenId: string; plaintext: string }> {
  const plaintext = `${TOKEN_PREFIX}${randomChars(TOKEN_ALPHABET, 24)}`;
  const tokenId = randomUUID().replace(/-/g, "");
  const now = new Date();
  await usersRepo().insertUserToken({
    id: tokenId,
    userId,
    label: "script-run",
    tokenHash: sha256Hex(plaintext),
    tokenPreview: plaintext.slice(-4),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
  return { tokenId, plaintext };
}

/** Revoke a token minted by `mintUserScriptRunToken`. No-op if already revoked. */
export async function revokeUserScriptRunToken(tokenId: string): Promise<void> {
  await usersRepo().revokeExpiringUserToken(tokenId, new Date().toISOString());
}

/**
 * Revoke a previously-minted token. Sets `revokedAt = now` and emits
 * `token_revoked`. Subsequent `resolveUserByToken(plaintext)` returns null.
 */
export async function revokeToken(tokenId: string, actor: IdentityActor): Promise<void> {
  await getStorage().transaction(async () => {
    const row = await usersRepo().findUserTokenSummary(tokenId);
    if (!row) {
      throw new Error(`Token not found: ${tokenId}`);
    }
    await usersRepo().setUserTokenRevoked(tokenId, new Date().toISOString());
    await recordIdentityEvent(
      row.userId,
      "token_revoked",
      actor,
      { tokenId, label: row.label, preview: row.tokenPreview },
      null,
    );
  });
}

/**
 * Revoke every live MCP token of a user and spend every unspent connector and
 * invite code for it, with one `token_revoked` event per token. Joins the
 * caller's transaction when there is one.
 */
export async function revokeAllUserCredentials(
  userId: string,
  actor: IdentityActor,
): Promise<void> {
  await getStorage().transaction(async () => {
    const now = new Date().toISOString();
    const live = await usersRepo().listUnrevokedUserTokens(userId);
    for (const token of live) {
      await usersRepo().setUserTokenRevoked(token.id, now);
      await recordIdentityEvent(
        userId,
        "token_revoked",
        actor,
        { tokenId: token.id, label: token.label, preview: token.tokenPreview },
        null,
      );
    }
    await usersRepo().spendUnusedConnectorCodes(userId, now);
  });
}

/**
 * Resolve a plaintext token to its owning user. Returns null if the token
 * is unknown or revoked. On a successful hit, updates `lastUsedAt` so the
 * People page can surface "last seen".
 */
export async function resolveUserByToken(plaintext: string): Promise<User | null> {
  return (await resolveUserToken(plaintext))?.user ?? null;
}

/** Like `resolveUserByToken`, plus the id of the `user_tokens` row that matched. */
export async function resolveUserToken(
  plaintext: string,
): Promise<{ user: User | null; tokenId: string } | null> {
  const hash = sha256Hex(plaintext);

  const row = await usersRepo().findUserTokenByHash(hash);
  if (!row || row.revokedAt !== null) return null;
  if (row.expiresAt !== null && Date.parse(row.expiresAt) <= Date.now()) return null;

  // Best-effort lastUsedAt update — never let a failure here leak to the
  // caller and block a successful token resolution.
  try {
    await usersRepo().touchUserToken(row.id, new Date().toISOString());
  } catch {
    // Never let a `lastUsedAt` update failure leak to the caller.
  }

  return { user: await findUserById(row.userId), tokenId: row.id };
}

/**
 * Whether `tokenId` is an unrevoked token of `userId`. Run it inside the
 * write transaction it guards: `setUserRoles` revokes tokens under the same
 * write lock.
 */
export async function isLiveUserToken(tokenId: string, userId: string): Promise<boolean> {
  return usersRepo().isLiveUserToken(tokenId, userId, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Session tokens (ephemeral, tasks and runtimes)
// ---------------------------------------------------------------------------

const SESSION_TOKEN_PREFIX = "aseph_"; // agent-swarm-ephemeral

/**
 * What an agent-principal session token is bound to: one task (ACP), one
 * runtime instance (runtime pools), or only its agent (a worker token).
 */
export type SessionTokenKind = "task" | "runtime" | "agent";

export class InvalidRuntimeTokenError extends Error {
  constructor() {
    super("Runtime token is no longer valid");
  }
}

/**
 * Mint a short-lived `aseph_<base62-24>` token scoped to an ACP session.
 * The token is handed to the ACP target process instead of the full operator
 * key; it expires at `now + ttlMs` and is actively revoked when the session
 * ends.
 */
export async function mintSessionToken(
  agentId: string,
  taskId: string,
  ttlMs: number,
  parent?: { tokenId: string; runtimeId: string | null },
): Promise<{ tokenId: string; plaintext: string }> {
  if (parent) {
    return await getStorage().transaction(async () => {
      // A runtime parent is matched by its runtime; an agent parent has no
      // binding but its agent, so it is matched by the empty binding columns.
      const parentExpiresAt = await sessionsRepo().findLiveParentTokenExpiry(
        parent.tokenId,
        agentId,
        parent.runtimeId,
        new Date().toISOString(),
      );
      if (parentExpiresAt === null) throw new InvalidRuntimeTokenError();
      return await insertSessionToken(
        agentId,
        taskId,
        null,
        ttlMs,
        parent.runtimeId,
        parentExpiresAt,
        null,
        parent.runtimeId ? null : parent.tokenId,
      );
    });
  }
  return await insertSessionToken(agentId, taskId, null, ttlMs);
}

function runtimeTokenTtlMs(): number {
  const hours = process.env.RUNTIME_TOKEN_TTL_HOURS ?? "168";
  return (validateRuntimeTokenTtlHours(hours) === null ? Number(hours) : 168) * 60 * 60 * 1000;
}

export async function mintRuntimeToken(
  agentId: string,
  runtimeId: string,
  ttlMs = runtimeTokenTtlMs(),
): Promise<{ tokenId: string; plaintext: string }> {
  return await insertSessionToken(agentId, null, runtimeId, ttlMs);
}

/**
 * Mint the short-lived `aseph_` token a script run uses for its `ctx.swarm`
 * SDK calls, so those calls present the executing agent instead of the swarm
 * API key (the operator). It resolves as a plain agent principal (`kind:
 * "agent"`, no task/runtime binding), so the API layer scopes it to that
 * agent's permissions: a lead keeps lead powers, a worker reads only its own
 * scope. Marked `scriptRun` so it stays apart from the agent's worker token
 * (see `AGENT_TOKEN_BINDING`). The run revokes it when it ends; `ttlMs` is the
 * backstop for a run that dies without revoking.
 */
export async function mintScriptRunToken(
  agentId: string,
  ttlMs: number,
  provenance: ScriptRunProvenance = {},
): Promise<{ tokenId: string; plaintext: string }> {
  const token = await insertSessionToken(
    agentId,
    null,
    null,
    ttlMs,
    null,
    undefined,
    null,
    null,
    true,
  );
  // Recorded before the plaintext leaves this function, so no request can
  // present the token without its provenance.
  if (
    provenance.sourceStepId ||
    provenance.sourceScriptRunId ||
    provenance.objectChain !== undefined ||
    provenance.depth !== undefined
  ) {
    await sessionsRepo().setSessionTokenProvenance(token.tokenId, {
      sourceStepId: provenance.sourceStepId ?? null,
      sourceScriptRunId: provenance.sourceScriptRunId ?? null,
      objectChain:
        provenance.objectChain === undefined ? null : JSON.stringify(provenance.objectChain),
      depth: provenance.depth ?? 0,
    });
  }
  return token;
}

/** Whether a session token was minted by `mintScriptRunToken`. */
export async function isScriptRunToken(tokenId: string): Promise<boolean> {
  return (await sessionsRepo().findSessionTokenScriptRun(tokenId)) === 1;
}

export async function insertSessionToken(
  agentId: string,
  taskId: string | null,
  runtimeId: string | null,
  ttlMs: number,
  parentRuntimeId: string | null = null,
  expiresAtCeiling?: string,
  controllerId: string | null = null,
  parentTokenId: string | null = null,
  scriptRun = false,
): Promise<{ tokenId: string; plaintext: string }> {
  const plaintext = `${SESSION_TOKEN_PREFIX}${randomChars(TOKEN_ALPHABET, 24)}`;
  const tokenId = randomUUID().replace(/-/g, "");
  const hash = sha256Hex(plaintext);
  const preview = plaintext.slice(-4);
  const now = new Date();
  const expiresAt = new Date(
    Math.min(now.getTime() + ttlMs, expiresAtCeiling ? Date.parse(expiresAtCeiling) : Infinity),
  ).toISOString();

  await sessionsRepo().insertSessionToken({
    id: tokenId,
    tokenHash: hash,
    tokenPreview: preview,
    agentId,
    taskId,
    runtimeId,
    parentRuntimeId,
    expiresAt,
    createdAt: now.toISOString(),
    controllerId,
    parentTokenId,
    scriptRun,
  });

  return { tokenId, plaintext };
}

/** Revoke a session token by id. No-op if already revoked. */
export async function revokeSessionToken(tokenId: string): Promise<void> {
  await getStorage().transaction(async () => {
    const row = await sessionsRepo().findSessionTokenRuntime(tokenId);
    if (row?.runtimeId) {
      await revokeRuntimeTokensForRuntime(row.runtimeId);
    } else {
      await revokeTokensWithChildren([tokenId]);
    }
  });
}

/** Revoke tokens and the child task tokens an agent token minted. */
async function revokeTokensWithChildren(tokenIds: string[]) {
  if (tokenIds.length === 0) return;
  const children = await sessionsRepo().listChildSessionTokenIds(tokenIds);
  const ids = [...tokenIds, ...children];
  await sessionsRepo().revokeSessionTokens(ids, new Date().toISOString());
  getStorage().afterCommit(() => {
    for (const id of tokenIds) unregisterVolatileSecret(`agent-token:${id}`);
    closeSessionTokenConnections(ids);
  });
}

export async function revokeRuntimeTokensForRuntime(runtimeId: string): Promise<void> {
  await getStorage().transaction(async () => {
    const ids = await sessionsRepo().listRuntimeSessionTokenIds(runtimeId);
    await sessionsRepo().revokeRuntimeSessionTokens(runtimeId, new Date().toISOString());
    getStorage().afterCommit(() => {
      unregisterVolatileSecret(`runtime:${runtimeId}`);
      closeSessionTokenConnections(ids);
    });
  });
}

// ---------------------------------------------------------------------------
// Agent tokens (long-lived, one agent, no runtime)
// ---------------------------------------------------------------------------

/*
 * An agent (worker) token is bound to its agent and nothing else. A script
 * run's ephemeral token shares the same all-null binding shape but has its own
 * lifecycle (see migration 233 and `mintScriptRunToken`): the sessions
 * repository's agent-token reads (its `AGENT_TOKEN_BINDING`) leave it out.
 */

/** Stored expiry of a token that does not expire. `expiresAt` is NOT NULL. */
export const AGENT_TOKEN_NO_EXPIRY = "9999-12-31T23:59:59.999Z";

/**
 * Default agent-token lifetime in ms. `null` means the token does not expire
 * and stays valid until it is rotated or revoked. A fixed lifetime (for
 * example 90 days) is a one-line change here.
 */
export const AGENT_TOKEN_DEFAULT_TTL_MS: number | null = null;

export type AgentTokenCredential = {
  tokenId: string;
  plaintext: string;
  /** null when the token does not expire. */
  expiresAt: string | null;
};

export class AgentTokenExistsError extends Error {
  constructor() {
    super("Agent already has an active token; rotate or revoke it");
  }
}

function storedExpiry(ttlMs: number | null): string {
  return ttlMs === null ? AGENT_TOKEN_NO_EXPIRY : new Date(Date.now() + ttlMs).toISOString();
}

function publicExpiry(expiresAt: string): string | null {
  return expiresAt === AGENT_TOKEN_NO_EXPIRY ? null : expiresAt;
}

async function activeAgentTokenIds(agentId: string) {
  return await sessionsRepo().listActiveAgentTokenIds(agentId, new Date().toISOString());
}

async function insertAgentToken(
  agentId: string,
  ttlMs: number | null,
): Promise<AgentTokenCredential> {
  const expiresAt = storedExpiry(ttlMs);
  // Pass the expiry as the ceiling so it is stored exactly; a TTL recomputed
  // from a later clock read could step past AGENT_TOKEN_NO_EXPIRY into year 10000.
  const token = await insertSessionToken(
    agentId,
    null,
    null,
    Number.MAX_SAFE_INTEGER,
    null,
    expiresAt,
  );
  getStorage().afterCommit(() =>
    registerVolatileSecret(token.plaintext, `agent-token:${token.tokenId}`),
  );
  return { ...token, expiresAt: publicExpiry(expiresAt) };
}

/**
 * Mint the agent-bound worker token for `agentId`. A worker runs on it in
 * place of the swarm API key. Throws `AgentTokenExistsError` when the agent
 * already holds an active one, so tokens do not accumulate silently.
 */
export async function mintAgentToken(
  agentId: string,
  ttlMs: number | null = AGENT_TOKEN_DEFAULT_TTL_MS,
): Promise<AgentTokenCredential> {
  return await getStorage().transaction(async () => {
    if ((await activeAgentTokenIds(agentId)).length > 0) {
      throw new AgentTokenExistsError();
    }
    return await insertAgentToken(agentId, ttlMs);
  });
}

/**
 * Replace the agent's active token. The old token keeps working for
 * `graceMs` so a running worker can pick up the new one, then expires. Its
 * child task tokens expire with it, so no credential it delegated outlives
 * it. Returns null when the agent holds no active token.
 */
export async function rotateAgentToken(
  agentId: string,
  graceMs: number,
  ttlMs: number | null = AGENT_TOKEN_DEFAULT_TTL_MS,
): Promise<(AgentTokenCredential & { previousExpiresAt: string }) | null> {
  return await getStorage().transaction(async () => {
    const previous = await activeAgentTokenIds(agentId);
    if (previous.length === 0) return null;
    const previousExpiresAt = new Date(Date.now() + graceMs).toISOString();
    await sessionsRepo().expireSessionTokensWithChildren(previous, previousExpiresAt);
    return { ...(await insertAgentToken(agentId, ttlMs)), previousExpiresAt };
  });
}

/** Revoke every active agent token of `agentId` and their child task tokens. */
export async function revokeAgentTokens(agentId: string): Promise<number> {
  return await getStorage().transaction(async () => {
    const ids = await activeAgentTokenIds(agentId);
    await revokeTokensWithChildren(ids);
    return ids.length;
  });
}

/**
 * Revoke every session token that authenticates as `agentId` (agent, runtime,
 * task and script-run kinds, plus their children). Controller tokens name a
 * controller, not the agent, and stay. Joins the caller's transaction.
 */
export async function revokeAllAgentSessionTokens(agentId: string): Promise<number> {
  return await getStorage().transaction(async () => {
    const ids = await sessionsRepo().listUnrevokedAgentSessionTokenIds(agentId);
    await revokeTokensWithChildren(ids);
    return ids.length;
  });
}

/**
 * Resolve a plaintext `aseph_` token to its principal. Returns null when the
 * token is unknown, revoked, or past its expiry. On a hit, touches `lastUsedAt`
 * best-effort unless `touch` is false.
 */
export async function resolveBySessionToken(
  plaintext: string,
  options: { touch?: boolean } = {},
): Promise<{
  tokenId: string;
  tokenKind: SessionTokenKind;
  agentId: string;
  taskId: string | null;
  runtimeId: string | null;
  expiresAt: string;
} | null> {
  const principal = await resolveSessionToken(plaintext, options);
  if (!principal || principal.kind === "controller") return null;
  const { kind: _, ...agent } = principal;
  return agent;
}

export async function resolveSessionToken(
  plaintext: string,
  options: { touch?: boolean } = {},
): Promise<
  | { kind: "controller"; controllerId: string; tokenId: string; expiresAt: string }
  | ({
      kind: "agent";
      tokenId: string;
      tokenKind: SessionTokenKind;
      agentId: string;
      taskId: string | null;
      runtimeId: string | null;
      expiresAt: string;
    } & ScriptRunProvenance)
  | null
> {
  if (!plaintext.startsWith(SESSION_TOKEN_PREFIX)) return null;
  const hash = sha256Hex(plaintext);
  const row = await sessionsRepo().findSessionTokenByHash(hash);
  if (!row || row.revokedAt !== null) return null;
  if (new Date(row.expiresAt) <= new Date()) return null;

  if (row.controllerId !== null) {
    return row.placement === "remote"
      ? {
          kind: "controller",
          controllerId: row.controllerId,
          tokenId: row.id,
          expiresAt: row.expiresAt,
        }
      : null;
  }

  if (options.touch !== false) {
    try {
      await sessionsRepo().touchSessionToken(row.id, new Date().toISOString());
    } catch {
      // best-effort
    }
  }

  return {
    kind: "agent",
    tokenId: row.id,
    tokenKind: row.taskId !== null ? "task" : row.runtimeId !== null ? "runtime" : "agent",
    agentId: row.agentId,
    taskId: row.taskId,
    runtimeId: row.runtimeId,
    expiresAt: row.expiresAt,
    ...(row.sourceStepId ? { sourceStepId: row.sourceStepId } : {}),
    ...(row.sourceScriptRunId ? { sourceScriptRunId: row.sourceScriptRunId } : {}),
    ...(row.objectChain !== null ? { objectChain: JSON.parse(row.objectChain) as string[] } : {}),
    depth: row.depth,
  };
}

// ---------------------------------------------------------------------------
// API-key fingerprint (operator audit)
// ---------------------------------------------------------------------------

/**
 * Q16: produce a short fingerprint of a raw operator API key for the
 * `user_identity_events.actor` column. Format: `op:<sha256(rawKey).slice(0, 16)>`.
 *
 * Step-1 only defines this helper; the operator auth middleware in step-8
 * will pass the raw key through `getApiKey()` from `src/utils/api-key.ts`
 * and then call this. Step-1 itself does NOT read the env directly, so the
 * api-key boundary check stays green.
 */
export function fingerprintApiKey(rawKey: string): string {
  return `op:${sha256Hex(rawKey).slice(0, 16)}`;
}
