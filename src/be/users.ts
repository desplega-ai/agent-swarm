/**
 * Canonical API-side identity surface — the only path that mutates identity
 * tables. Every mutating helper wraps row mutation + event emission in a
 * single `getDbClient().transaction()` so the invariant "every identity
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

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { scheduleOrgDomainRecompute } from "../telemetry-identity";
import type { User } from "../types";
import { registerVolatileSecret, unregisterVolatileSecret } from "../utils/secret-scrubber";
import { closeSessionTokenConnections } from "../utils/session-token-connections";
import { getDbClient } from "./db";
import type { DbExecutor } from "./db-client";
import { validateRuntimeTokenTtlHours } from "./swarm-config-guard";

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
};

function actorString(actor: IdentityActor): string {
  return `${actor.kind}:${actor.id}`;
}

/** Internal row shape — superset of `User` plus columns added in migration 064. */
type UserRow = {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  notes: string | null;
  emailAliases: string | null;
  preferredChannel: string | null;
  timezone: string | null;
  metadata: string | null;
  dailyBudgetUsd: number | null;
  status: string;
  createdAt: string;
  lastUpdatedAt: string;
};

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
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** Single SELECT by primary key. */
export async function findUserById(id: string): Promise<User | null> {
  const row = await getDbClient().get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  return row ? rowToUser(row) : null;
}

/**
 * Look up a user by an `(kind, externalId)` pair via `user_external_ids`.
 * Returns null if no mapping exists. Use this for webhook auto-link paths.
 */
export async function findUserByExternalId(kind: string, externalId: string): Promise<User | null> {
  const row = await getDbClient().get<UserRow>(
    `SELECT u.* FROM users u
       INNER JOIN user_external_ids x ON x.userId = u.id
       WHERE x.kind = ? AND x.externalId = ?`,
    [kind, externalId],
  );
  return row ? rowToUser(row) : null;
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
  const db = getDbClient();

  // Primary email (case-insensitive)
  const primary = await db.get<UserRow>("SELECT * FROM users WHERE LOWER(email) = LOWER(?)", [
    email,
  ]);
  if (primary) return rowToUser(primary);

  // Alias array
  const aliasRows = await db.query<UserRow>(
    "SELECT * FROM users WHERE emailAliases IS NOT NULL AND emailAliases != '[]'",
  );
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
  const client = getDbClient();

  const exact = await client.query<UserRow>("SELECT * FROM users WHERE LOWER(name) = LOWER(?)", [
    trimmed,
  ]);
  if (exact.length > 0) return exact.map(rowToUser);

  const firstToken = trimmed.split(/\s+/)[0] ?? trimmed;
  const prefixed = await client.query<UserRow>(
    "SELECT * FROM users WHERE LOWER(name) LIKE LOWER(?) || '%'",
    [firstToken],
  );
  return prefixed.map(rowToUser);
}

/**
 * Return all `(kind, externalId)` mappings for a user — used by the People
 * page detail view to render identity badges in one request.
 */
export async function getUserIdentities(
  userId: string,
): Promise<Array<{ kind: string; externalId: string }>> {
  return getDbClient().query<{ kind: string; externalId: string }>(
    "SELECT kind, externalId FROM user_external_ids WHERE userId = ? ORDER BY kind, externalId",
    [userId],
  );
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

type IdentityEventRow = {
  id: string;
  userId: string;
  eventType: string;
  actor: string;
  beforeJson: string | null;
  afterJson: string | null;
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
 * Paginated event timeline for a user. `limit` is hard-capped at 200; `before`
 * is a cursor on `createdAt` (ISO string) so the caller can keep paging by
 * passing back the last event's `createdAt`.
 */
export async function listUserEvents(
  userId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<IdentityEvent[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const before = opts.before;
  const client = getDbClient();
  if (before) {
    const rows = await client.query<IdentityEventRow>(
      `SELECT id, userId, eventType, actor, beforeJson, afterJson, createdAt
           FROM user_identity_events
          WHERE userId = ? AND createdAt < ?
          ORDER BY createdAt DESC, rowid DESC
          LIMIT ?`,
      [userId, before, limit],
    );
    return rows.map(rowToEvent);
  }
  const rows = await client.query<IdentityEventRow>(
    `SELECT id, userId, eventType, actor, beforeJson, afterJson, createdAt
         FROM user_identity_events
        WHERE userId = ?
        ORDER BY createdAt DESC, rowid DESC
        LIMIT ?`,
    [userId, limit],
  );
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

type UserTokenRow = UserTokenSummary;

/**
 * List a user's MCP tokens (without the hash). Used to render the People
 * page token panel — the mint/revoke endpoints + UI dialog ship with the
 * MCP-token plan, this helper lands here so step-8's `GET /users` response
 * can include token summaries.
 */
export async function listUserTokens(userId: string): Promise<UserTokenSummary[]> {
  return getDbClient().query<UserTokenRow>(
    `SELECT id, userId, label, tokenPreview, createdAt, lastUsedAt, revokedAt
         FROM user_tokens
        WHERE userId = ?
        ORDER BY createdAt DESC`,
    [userId],
  );
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
  await getDbClient().run(
    `INSERT INTO user_identity_events (id, userId, eventType, actor, beforeJson, afterJson, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID().replace(/-/g, ""),
      userId,
      eventType,
      actorString(actor),
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      new Date().toISOString(),
    ],
  );
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
 * Only the create branch is wrapped in `getDbClient().transaction()` so the
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

  const created = await getDbClient().transaction(async (tx) => {
    await tx.run(
      `INSERT INTO users (id, name, email, role, notes, emailAliases, preferredChannel, timezone, createdAt, lastUpdatedAt, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        id,
        name,
        email,
        hints.role ?? null,
        hints.notes ?? null,
        "[]",
        hints.preferredChannel ?? "slack",
        null,
        now,
        now,
      ],
    );
    const row = await tx.get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
    if (!row) throw new Error("Failed to create user");
    await recordIdentityEvent(id, "identity_added", actor, null, { email, name });
    return rowToUser(row);
  });
  // The org's email domain may come from this user (debounced, post-commit).
  getDbClient().afterCommit(scheduleOrgDomainRecompute);

  return { user: created, created: true };
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
  await getDbClient().transaction(async (tx) => {
    await tx.run("INSERT INTO user_external_ids (userId, kind, externalId) VALUES (?, ?, ?)", [
      userId,
      kind,
      externalId,
    ]);
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
  await getDbClient().transaction(async (tx) => {
    await tx.run("DELETE FROM user_external_ids WHERE userId = ? AND kind = ? AND externalId = ?", [
      userId,
      kind,
      externalId,
    ]);
    await recordIdentityEvent(userId, "identity_removed", actor, { kind, externalId }, null);
  });
}

// ---------------------------------------------------------------------------
// Tokens — schema + helpers land here (Q20). Mint/revoke endpoints + UI
// dialog ship with the separate MCP-token plan.
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = "aswt_"; // agent-swarm-token

function base62(bytes: Uint8Array): string {
  // Map random bytes into base62 alphabet for URL-safe, unambiguous tokens.
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (const b of bytes) {
    out += alphabet[b % 62];
  }
  return out;
}

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
  // 24 base62 chars from 24 random bytes (~143 bits of entropy).
  const plaintext = `${TOKEN_PREFIX}${base62(randomBytes(24))}`;
  const tokenId = randomUUID().replace(/-/g, "");
  const hash = sha256Hex(plaintext);
  const preview = plaintext.slice(-4);
  const now = new Date().toISOString();

  await getDbClient().transaction(async (tx) => {
    await tx.run(
      `INSERT INTO user_tokens (id, userId, label, tokenHash, tokenPreview, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [tokenId, userId, label, hash, preview, now],
    );
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
 * Revoke a previously-minted token. Sets `revokedAt = now` and emits
 * `token_revoked`. Subsequent `resolveUserByToken(plaintext)` returns null.
 */
export async function revokeToken(tokenId: string, actor: IdentityActor): Promise<void> {
  await getDbClient().transaction(async (tx) => {
    const row = await tx.get<{ userId: string; label: string | null; tokenPreview: string }>(
      "SELECT userId, label, tokenPreview FROM user_tokens WHERE id = ?",
      [tokenId],
    );
    if (!row) {
      throw new Error(`Token not found: ${tokenId}`);
    }
    await tx.run("UPDATE user_tokens SET revokedAt = ? WHERE id = ?", [
      new Date().toISOString(),
      tokenId,
    ]);
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
 * Resolve a plaintext token to its owning user. Returns null if the token
 * is unknown or revoked. On a successful hit, updates `lastUsedAt` so the
 * People page can surface "last seen".
 */
export async function resolveUserByToken(plaintext: string): Promise<User | null> {
  const hash = sha256Hex(plaintext);
  const client = getDbClient();

  const row = await client.get<{ id: string; userId: string; revokedAt: string | null }>(
    "SELECT id, userId, revokedAt FROM user_tokens WHERE tokenHash = ?",
    [hash],
  );
  if (!row || row.revokedAt !== null) return null;

  // Best-effort lastUsedAt update — never let a failure here leak to the
  // caller and block a successful token resolution.
  try {
    await client.run("UPDATE user_tokens SET lastUsedAt = ? WHERE id = ?", [
      new Date().toISOString(),
      row.id,
    ]);
  } catch {
    // Never let a `lastUsedAt` update failure leak to the caller.
  }

  return findUserById(row.userId);
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
    return await getDbClient().transaction(async (client) => {
      // A runtime parent is matched by its runtime; an agent parent has no
      // binding but its agent, so it is matched by the empty binding columns.
      const row = await client.get<{ expiresAt: string }>(
        parent.runtimeId
          ? `SELECT expiresAt FROM session_tokens WHERE id = ? AND agentId = ? AND runtimeId = ?
             AND revokedAt IS NULL AND expiresAt > ?`
          : `SELECT expiresAt FROM session_tokens WHERE id = ? AND agentId = ? AND ${AGENT_TOKEN_BINDING}
             AND revokedAt IS NULL AND expiresAt > ?`,
        parent.runtimeId
          ? [parent.tokenId, agentId, parent.runtimeId, new Date().toISOString()]
          : [parent.tokenId, agentId, new Date().toISOString()],
      );
      if (!row) throw new InvalidRuntimeTokenError();
      return await insertSessionToken(
        agentId,
        taskId,
        null,
        ttlMs,
        parent.runtimeId,
        row.expiresAt,
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
): Promise<{ tokenId: string; plaintext: string }> {
  return await insertSessionToken(agentId, null, null, ttlMs, null, undefined, null, null, true);
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
  const plaintext = `${SESSION_TOKEN_PREFIX}${base62(randomBytes(24))}`;
  const tokenId = randomUUID().replace(/-/g, "");
  const hash = sha256Hex(plaintext);
  const preview = plaintext.slice(-4);
  const now = new Date();
  const expiresAt = new Date(
    Math.min(now.getTime() + ttlMs, expiresAtCeiling ? Date.parse(expiresAtCeiling) : Infinity),
  ).toISOString();

  await getDbClient().run(
    `INSERT INTO session_tokens
     (id, tokenHash, tokenPreview, agentId, taskId, runtimeId, parentRuntimeId, expiresAt, createdAt, controllerId, parentTokenId, scriptRun)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tokenId,
      hash,
      preview,
      agentId,
      taskId,
      runtimeId,
      parentRuntimeId,
      expiresAt,
      now.toISOString(),
      controllerId,
      parentTokenId,
      scriptRun ? 1 : 0,
    ],
  );

  return { tokenId, plaintext };
}

/** Revoke a session token by id. No-op if already revoked. */
export async function revokeSessionToken(tokenId: string): Promise<void> {
  await getDbClient().transaction(async (client) => {
    const row = await client.get<{ runtimeId: string | null }>(
      "SELECT runtimeId FROM session_tokens WHERE id = ?",
      [tokenId],
    );
    if (row?.runtimeId) {
      await revokeRuntimeTokensForRuntime(row.runtimeId);
    } else {
      await revokeTokensWithChildren(client, [tokenId]);
    }
  });
}

/** Revoke tokens and the child task tokens an agent token minted. */
async function revokeTokensWithChildren(client: DbExecutor, tokenIds: string[]) {
  if (tokenIds.length === 0) return;
  const placeholders = tokenIds.map(() => "?").join(", ");
  const children = await client.query<{ id: string }>(
    `SELECT id FROM session_tokens WHERE parentTokenId IN (${placeholders})`,
    tokenIds,
  );
  const ids = [...tokenIds, ...children.map((row) => row.id)];
  await client.run(
    `UPDATE session_tokens SET revokedAt = ?
     WHERE id IN (${ids.map(() => "?").join(", ")}) AND revokedAt IS NULL`,
    [new Date().toISOString(), ...ids],
  );
  getDbClient().afterCommit(() => {
    for (const id of tokenIds) unregisterVolatileSecret(`agent-token:${id}`);
    closeSessionTokenConnections(ids);
  });
}

export async function revokeRuntimeTokensForRuntime(runtimeId: string): Promise<void> {
  await getDbClient().transaction(async (client) => {
    const rows = await client.query<{ id: string }>(
      "SELECT id FROM session_tokens WHERE runtimeId = ? OR parentRuntimeId = ?",
      [runtimeId, runtimeId],
    );
    await client.run(
      `UPDATE session_tokens SET revokedAt = ?
       WHERE (runtimeId = ? OR parentRuntimeId = ?) AND revokedAt IS NULL`,
      [new Date().toISOString(), runtimeId, runtimeId],
    );
    getDbClient().afterCommit(() => {
      unregisterVolatileSecret(`runtime:${runtimeId}`);
      closeSessionTokenConnections(rows.map((row) => row.id));
    });
  });
}

// ---------------------------------------------------------------------------
// Agent tokens (long-lived, one agent, no runtime)
// ---------------------------------------------------------------------------

/**
 * SQL predicate for an agent (worker) token: bound to its agent and nothing
 * else. `scriptRun = 0` excludes a script run's ephemeral token, which shares
 * the same all-null binding shape but has its own lifecycle (see migration 233
 * and `mintScriptRunToken`).
 */
const AGENT_TOKEN_BINDING =
  "taskId IS NULL AND runtimeId IS NULL AND controllerId IS NULL AND parentRuntimeId IS NULL AND scriptRun = 0";

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

async function activeAgentTokenIds(client: DbExecutor, agentId: string) {
  const rows = await client.query<{ id: string }>(
    `SELECT id FROM session_tokens WHERE agentId = ? AND ${AGENT_TOKEN_BINDING}
     AND revokedAt IS NULL AND expiresAt > ?`,
    [agentId, new Date().toISOString()],
  );
  return rows.map((row) => row.id);
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
  getDbClient().afterCommit(() =>
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
  return await getDbClient().transaction(async (client) => {
    if ((await activeAgentTokenIds(client, agentId)).length > 0) {
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
  return await getDbClient().transaction(async (client) => {
    const previous = await activeAgentTokenIds(client, agentId);
    if (previous.length === 0) return null;
    const previousExpiresAt = new Date(Date.now() + graceMs).toISOString();
    const placeholders = previous.map(() => "?").join(", ");
    await client.run(
      `UPDATE session_tokens SET expiresAt = ?
       WHERE (id IN (${placeholders}) OR parentTokenId IN (${placeholders})) AND expiresAt > ?`,
      [previousExpiresAt, ...previous, ...previous, previousExpiresAt],
    );
    return { ...(await insertAgentToken(agentId, ttlMs)), previousExpiresAt };
  });
}

/** Revoke every active agent token of `agentId` and their child task tokens. */
export async function revokeAgentTokens(agentId: string): Promise<number> {
  return await getDbClient().transaction(async (client) => {
    const ids = await activeAgentTokenIds(client, agentId);
    await revokeTokensWithChildren(client, ids);
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
  | {
      kind: "agent";
      tokenId: string;
      tokenKind: SessionTokenKind;
      agentId: string;
      taskId: string | null;
      runtimeId: string | null;
      expiresAt: string;
    }
  | null
> {
  if (!plaintext.startsWith(SESSION_TOKEN_PREFIX)) return null;
  const hash = sha256Hex(plaintext);
  const client = getDbClient();

  const row = await client.get<{
    id: string;
    agentId: string;
    taskId: string | null;
    runtimeId: string | null;
    controllerId: string | null;
    placement: string | null;
    expiresAt: string;
    revokedAt: string | null;
  }>(
    `SELECT s.id, s.agentId, s.taskId, s.runtimeId, s.controllerId, s.expiresAt, s.revokedAt,
     c.placement FROM session_tokens s LEFT JOIN runtime_controllers c ON c.id = s.controllerId
     WHERE s.tokenHash = ?`,
    [hash],
  );
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
      await client.run("UPDATE session_tokens SET lastUsedAt = ? WHERE id = ?", [
        new Date().toISOString(),
        row.id,
      ]);
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
