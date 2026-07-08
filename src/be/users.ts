/**
 * Canonical API-side identity surface — the only path that mutates identity
 * tables. Every mutating helper wraps row mutation + event emission in a
 * single `db.transaction()` so the invariant "every identity mutation has a
 * matching event row" (Q9) holds even on partial failures.
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
import type { User } from "../types";
import { getDb } from "./db";

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
export function findUserById(id: string): User | null {
  const row = getDb().prepare<UserRow, string>("SELECT * FROM users WHERE id = ?").get(id);
  return row ? rowToUser(row) : null;
}

/**
 * Look up a user by an `(kind, externalId)` pair via `user_external_ids`.
 * Returns null if no mapping exists. Use this for webhook auto-link paths.
 */
export function findUserByExternalId(kind: string, externalId: string): User | null {
  const row = getDb()
    .prepare<UserRow, [string, string]>(
      `SELECT u.* FROM users u
       INNER JOIN user_external_ids x ON x.userId = u.id
       WHERE x.kind = ? AND x.externalId = ?`,
    )
    .get(kind, externalId);
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
export function findUserByEmail(email: string): User | null {
  const lower = email.toLowerCase();
  const db = getDb();

  // Primary email (case-insensitive)
  const primary = db
    .prepare<UserRow, string>("SELECT * FROM users WHERE LOWER(email) = LOWER(?)")
    .get(email);
  if (primary) return rowToUser(primary);

  // Alias array
  const aliasRows = db
    .prepare<UserRow, []>(
      "SELECT * FROM users WHERE emailAliases IS NOT NULL AND emailAliases != '[]'",
    )
    .all();
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
export function findUsersByName(name: string): User[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const db = getDb();

  const exact = db
    .prepare<UserRow, string>("SELECT * FROM users WHERE LOWER(name) = LOWER(?)")
    .all(trimmed);
  if (exact.length > 0) return exact.map(rowToUser);

  const firstToken = trimmed.split(/\s+/)[0] ?? trimmed;
  const prefixed = db
    .prepare<UserRow, string>("SELECT * FROM users WHERE LOWER(name) LIKE LOWER(?) || '%'")
    .all(firstToken);
  return prefixed.map(rowToUser);
}

/**
 * Return all `(kind, externalId)` mappings for a user — used by the People
 * page detail view to render identity badges in one request.
 */
export function getUserIdentities(userId: string): Array<{ kind: string; externalId: string }> {
  return getDb()
    .prepare<{ kind: string; externalId: string }, string>(
      "SELECT kind, externalId FROM user_external_ids WHERE userId = ? ORDER BY kind, externalId",
    )
    .all(userId);
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
export function listUserEvents(
  userId: string,
  opts: { limit?: number; before?: string } = {},
): IdentityEvent[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const before = opts.before;
  const db = getDb();
  if (before) {
    return db
      .prepare<IdentityEventRow, [string, string, number]>(
        `SELECT id, userId, eventType, actor, beforeJson, afterJson, createdAt
           FROM user_identity_events
          WHERE userId = ? AND createdAt < ?
          ORDER BY createdAt DESC, rowid DESC
          LIMIT ?`,
      )
      .all(userId, before, limit)
      .map(rowToEvent);
  }
  return db
    .prepare<IdentityEventRow, [string, number]>(
      `SELECT id, userId, eventType, actor, beforeJson, afterJson, createdAt
         FROM user_identity_events
        WHERE userId = ?
        ORDER BY createdAt DESC, rowid DESC
        LIMIT ?`,
    )
    .all(userId, limit)
    .map(rowToEvent);
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
export function listUserTokens(userId: string): UserTokenSummary[] {
  return getDb()
    .prepare<UserTokenRow, string>(
      `SELECT id, userId, label, tokenPreview, createdAt, lastUsedAt, revokedAt
         FROM user_tokens
        WHERE userId = ?
        ORDER BY createdAt DESC`,
    )
    .all(userId);
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
export function recordIdentityEvent(
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
): void {
  getDb()
    .prepare(
      `INSERT INTO user_identity_events (id, userId, eventType, actor, beforeJson, afterJson, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID().replace(/-/g, ""),
      userId,
      eventType,
      actorString(actor),
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      new Date().toISOString(),
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
 * Wrapped in `db.transaction()` so create + event land together.
 */
export function findOrCreateUserByEmail(
  email: string,
  hints: { name?: string; role?: string; notes?: string; preferredChannel?: string },
  actor: IdentityActor,
): { user: User; created: boolean } {
  const existing = findUserByEmail(email);
  if (existing) {
    recordIdentityEvent(existing.id, "auto_merge", actor, null, { email, hints });
    return { user: existing, created: false };
  }

  const id = randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const name = hints.name?.trim() || email.split("@")[0] || email;
  const db = getDb();

  const created = db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, name, email, role, notes, emailAliases, preferredChannel, timezone, createdAt, lastUpdatedAt, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    ).run(
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
    );
    const row = db.prepare<UserRow, string>("SELECT * FROM users WHERE id = ?").get(id);
    if (!row) throw new Error("Failed to create user");
    recordIdentityEvent(id, "identity_added", actor, null, { email, name });
    return rowToUser(row);
  })();

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
export function linkIdentity(
  userId: string,
  kind: string,
  externalId: string,
  actor: IdentityActor,
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("INSERT INTO user_external_ids (userId, kind, externalId) VALUES (?, ?, ?)").run(
      userId,
      kind,
      externalId,
    );
    recordIdentityEvent(userId, "identity_added", actor, null, { kind, externalId });
  })();
}

/**
 * Remove an `(kind, externalId)` mapping. No-op if no row matched — but we
 * still emit the event with the same before/after for the audit trail.
 * Atomic: DELETE + event in one transaction.
 */
export function unlinkIdentity(
  userId: string,
  kind: string,
  externalId: string,
  actor: IdentityActor,
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      "DELETE FROM user_external_ids WHERE userId = ? AND kind = ? AND externalId = ?",
    ).run(userId, kind, externalId);
    recordIdentityEvent(userId, "identity_removed", actor, { kind, externalId }, null);
  })();
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
export function mintToken(
  userId: string,
  label: string | null,
  actor: IdentityActor,
): { tokenId: string; plaintext: string } {
  // 24 base62 chars from 24 random bytes (~143 bits of entropy).
  const plaintext = `${TOKEN_PREFIX}${base62(randomBytes(24))}`;
  const tokenId = randomUUID().replace(/-/g, "");
  const hash = sha256Hex(plaintext);
  const preview = plaintext.slice(-4);
  const now = new Date().toISOString();

  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO user_tokens (id, userId, label, tokenHash, tokenPreview, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(tokenId, userId, label, hash, preview, now);
    recordIdentityEvent(userId, "token_minted", actor, null, { tokenId, label, preview });
  })();

  return { tokenId, plaintext };
}

/**
 * Revoke a previously-minted token. Sets `revokedAt = now` and emits
 * `token_revoked`. Subsequent `resolveUserByToken(plaintext)` returns null.
 */
export function revokeToken(tokenId: string, actor: IdentityActor): void {
  const db = getDb();
  db.transaction(() => {
    const row = db
      .prepare<{ userId: string; label: string | null; tokenPreview: string }, string>(
        "SELECT userId, label, tokenPreview FROM user_tokens WHERE id = ?",
      )
      .get(tokenId);
    if (!row) {
      throw new Error(`Token not found: ${tokenId}`);
    }
    db.prepare("UPDATE user_tokens SET revokedAt = ? WHERE id = ?").run(
      new Date().toISOString(),
      tokenId,
    );
    recordIdentityEvent(
      row.userId,
      "token_revoked",
      actor,
      { tokenId, label: row.label, preview: row.tokenPreview },
      null,
    );
  })();
}

/**
 * Resolve a plaintext token to its owning user. Returns null if the token
 * is unknown or revoked. On a successful hit, fires-and-forgets a
 * `lastUsedAt` update so the People page can surface "last seen" without
 * blocking the request path.
 */
export function resolveUserByToken(plaintext: string): User | null {
  const hash = sha256Hex(plaintext);
  const db = getDb();

  const row = db
    .prepare<{ id: string; userId: string; revokedAt: string | null }, string>(
      "SELECT id, userId, revokedAt FROM user_tokens WHERE tokenHash = ?",
    )
    .get(hash);
  if (!row || row.revokedAt !== null) return null;

  // Fire-and-forget lastUsedAt update. Synchronous bun:sqlite write is fast
  // enough that we don't need to defer to a microtask; treating it as
  // best-effort keeps the call-site clean.
  try {
    db.prepare("UPDATE user_tokens SET lastUsedAt = ? WHERE id = ?").run(
      new Date().toISOString(),
      row.id,
    );
  } catch {
    // Never let a `lastUsedAt` update failure leak to the caller.
  }

  return findUserById(row.userId);
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
