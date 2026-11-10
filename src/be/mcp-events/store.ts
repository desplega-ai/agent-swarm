/**
 * Storage for MCP Events webhook subscriptions (`mcp_event_subscriptions`,
 * migration 325). Secrets are sealed at rest with the swarm encryption key.
 */

import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret, getEncryptionKey } from "@/be/crypto";
import { getDbClient } from "@/be/db";
import type { DeliveryErrorCategory } from "./webhook";

export type SubscriptionRow = {
  id: string;
  userId: string;
  eventName: string;
  argumentsJson: string;
  url: string;
  secretSealed: string;
  previousSecretSealed: string | null;
  previousSecretUntil: string | null;
  verifiedAt: string;
  expiresAt: string;
  lastDeliveryAt: string | null;
  lastError: DeliveryErrorCategory | null;
  failedSince: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Canonical JSON: object keys sorted at every depth, so key order is irrelevant. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Deterministic id over the subscription key (principal, url, name, arguments). */
export function subscriptionIdFor(
  userId: string,
  url: string,
  eventName: string,
  argumentsJson: string,
): string {
  const digest = createHash("sha256")
    .update(canonicalJson([userId, url, eventName, argumentsJson]))
    .digest("hex");
  return `sub_${digest.slice(0, 32)}`;
}

export function sealSecret(secret: string): string {
  return encryptSecret(secret, getEncryptionKey());
}

export function unsealSecret(sealed: string): string {
  return decryptSecret(sealed, getEncryptionKey());
}

export async function getSubscription(id: string): Promise<SubscriptionRow | null> {
  return getDbClient().get<SubscriptionRow>("SELECT * FROM mcp_event_subscriptions WHERE id = ?", [
    id,
  ]);
}

export async function countLiveSubscriptions(userId: string, nowIso: string): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM mcp_event_subscriptions WHERE userId = ? AND expiresAt > ?",
    [userId, nowIso],
  );
  return row?.n ?? 0;
}

/**
 * The latest verification time, after `sinceIso`, of this user's live
 * subscriptions to `url`; null when none. A new subscription reuses that time,
 * so skipping the challenge never extends the verification window.
 */
export async function latestVerification(
  userId: string,
  url: string,
  sinceIso: string,
  nowIso: string,
): Promise<string | null> {
  const row = await getDbClient().get<{ verifiedAt: string | null }>(
    `SELECT MAX(verifiedAt) AS verifiedAt FROM mcp_event_subscriptions
     WHERE userId = ? AND url = ? AND verifiedAt > ? AND expiresAt > ?`,
    [userId, url, sinceIso, nowIso],
  );
  return row?.verifiedAt ?? null;
}

export async function deleteExpiredSubscriptions(nowIso: string): Promise<number> {
  const result = await getDbClient().run(
    "DELETE FROM mcp_event_subscriptions WHERE expiresAt <= ?",
    [nowIso],
  );
  return result.changes;
}

export async function upsertSubscription(input: {
  id: string;
  userId: string;
  eventName: string;
  argumentsJson: string;
  url: string;
  secret: string;
  verifiedAt: string;
  expiresAt: string;
  nowIso: string;
  rotationGraceUntil: string;
  /** Live subscriptions a user may hold; a new key past it is refused. */
  maxActivePerUser: number;
}): Promise<SubscriptionRow | "limit"> {
  const sealed = sealSecret(input.secret);
  return getDbClient().transaction(async (tx) => {
    const existing = await tx.get<SubscriptionRow>(
      "SELECT * FROM mcp_event_subscriptions WHERE id = ?",
      [input.id],
    );
    if (!existing || existing.expiresAt <= input.nowIso) {
      // Counted inside the write transaction, so concurrent subscribes cannot overshoot.
      const live = await tx.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM mcp_event_subscriptions
         WHERE userId = ? AND expiresAt > ? AND id != ?`,
        [input.userId, input.nowIso, input.id],
      );
      if ((live?.n ?? 0) >= input.maxActivePerUser) return "limit";
    }
    if (!existing) {
      await tx.run(
        `INSERT INTO mcp_event_subscriptions
           (id, userId, eventName, argumentsJson, url, secretSealed, verifiedAt, expiresAt,
            createdAt, updatedAt, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.userId,
          input.eventName,
          input.argumentsJson,
          input.url,
          sealed,
          input.verifiedAt,
          input.expiresAt,
          input.nowIso,
          input.nowIso,
          input.userId,
          input.userId,
        ],
      );
    } else {
      // A changed secret is a rotation: keep the old one for a dual-signing window.
      const rotated = unsealSecret(existing.secretSealed) !== input.secret;
      await tx.run(
        `UPDATE mcp_event_subscriptions
         SET secretSealed = ?,
             previousSecretSealed = ?,
             previousSecretUntil = ?,
             verifiedAt = ?,
             expiresAt = ?,
             updatedAt = ?,
             updated_by = ?
         WHERE id = ?`,
        [
          sealed,
          rotated ? existing.secretSealed : existing.previousSecretSealed,
          rotated ? input.rotationGraceUntil : existing.previousSecretUntil,
          input.verifiedAt,
          input.expiresAt,
          input.nowIso,
          input.userId,
          input.id,
        ],
      );
    }
    const row = await tx.get<SubscriptionRow>(
      "SELECT * FROM mcp_event_subscriptions WHERE id = ?",
      [input.id],
    );
    if (!row) throw new Error(`subscription ${input.id} vanished during upsert`);
    return row;
  });
}

export async function deleteSubscription(id: string, userId: string): Promise<boolean> {
  const result = await getDbClient().run(
    "DELETE FROM mcp_event_subscriptions WHERE id = ? AND userId = ?",
    [id, userId],
  );
  return result.changes > 0;
}

export async function listLiveSubscriptions(
  userId: string,
  eventName: string,
  nowIso: string,
): Promise<SubscriptionRow[]> {
  return getDbClient().query<SubscriptionRow>(
    `SELECT * FROM mcp_event_subscriptions
     WHERE userId = ? AND eventName = ? AND expiresAt > ?`,
    [userId, eventName, nowIso],
  );
}

export async function recordDeliveryOutcome(
  id: string,
  outcome:
    | { ok: true; atIso: string }
    | { ok: false; category: DeliveryErrorCategory; atIso: string },
): Promise<void> {
  if (outcome.ok) {
    await getDbClient().run(
      `UPDATE mcp_event_subscriptions
       SET lastDeliveryAt = ?, lastError = NULL, failedSince = NULL
       WHERE id = ?`,
      [outcome.atIso, id],
    );
    return;
  }
  await getDbClient().run(
    `UPDATE mcp_event_subscriptions
     SET lastError = ?, failedSince = COALESCE(failedSince, ?)
     WHERE id = ?`,
    [outcome.category, outcome.atIso, id],
  );
}
