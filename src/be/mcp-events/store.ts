/**
 * Storage for MCP Events webhook subscriptions (`mcp_event_subscriptions`,
 * migration 325). Secrets are sealed at rest with the swarm encryption key.
 */

import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret, getEncryptionKey } from "@/be/crypto";
import { getStorage } from "@/be/storage";
import type { DeliveryErrorCategory } from "./webhook";

export type SubscriptionRow = {
  id: string;
  userId: string;
  tokenId: string;
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
  return (await getStorage().repos.mcpServers.findSubscription(id)) as SubscriptionRow | null;
}

export async function countLiveSubscriptions(userId: string, nowIso: string): Promise<number> {
  return getStorage().repos.mcpServers.countLiveSubscriptions(userId, nowIso);
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
  return getStorage().repos.mcpServers.latestVerification(userId, url, sinceIso, nowIso);
}

export async function deleteExpiredSubscriptions(nowIso: string): Promise<number> {
  return getStorage().repos.mcpServers.deleteExpiredSubscriptions(nowIso);
}

export async function upsertSubscription(input: {
  id: string;
  userId: string;
  tokenId: string;
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
  const storage = getStorage();
  const repo = storage.repos.mcpServers;
  return storage.transaction(async () => {
    const existing = (await repo.findSubscription(input.id)) as SubscriptionRow | null;
    if (!existing || existing.expiresAt <= input.nowIso) {
      // Counted inside the write transaction, so concurrent subscribes cannot overshoot.
      const live = await repo.countLiveSubscriptions(input.userId, input.nowIso, input.id);
      if (live >= input.maxActivePerUser) return "limit";
    }
    if (!existing) {
      await repo.insertSubscription({
        id: input.id,
        userId: input.userId,
        tokenId: input.tokenId,
        eventName: input.eventName,
        argumentsJson: input.argumentsJson,
        url: input.url,
        secretSealed: sealed,
        verifiedAt: input.verifiedAt,
        expiresAt: input.expiresAt,
        now: input.nowIso,
      });
    } else {
      // A changed secret is a rotation: keep the old one for a dual-signing window.
      const rotated = unsealSecret(existing.secretSealed) !== input.secret;
      await repo.renewSubscription(input.id, {
        tokenId: input.tokenId,
        secretSealed: sealed,
        previousSecretSealed: rotated ? existing.secretSealed : existing.previousSecretSealed,
        previousSecretUntil: rotated ? input.rotationGraceUntil : existing.previousSecretUntil,
        verifiedAt: input.verifiedAt,
        expiresAt: input.expiresAt,
        now: input.nowIso,
        actor: input.userId,
      });
    }
    const row = (await repo.findSubscription(input.id)) as SubscriptionRow | null;
    if (!row) throw new Error(`subscription ${input.id} vanished during upsert`);
    return row;
  });
}

export async function deleteSubscription(id: string, userId: string): Promise<boolean> {
  return getStorage().repos.mcpServers.deleteSubscription(id, userId);
}

export async function listLiveSubscriptions(
  userId: string,
  eventName: string,
  nowIso: string,
): Promise<SubscriptionRow[]> {
  return (await getStorage().repos.mcpServers.listLiveSubscriptions(
    userId,
    eventName,
    nowIso,
  )) as SubscriptionRow[];
}

export async function recordDeliveryOutcome(
  id: string,
  outcome:
    | { ok: true; atIso: string }
    | { ok: false; category: DeliveryErrorCategory; atIso: string },
): Promise<void> {
  const repo = getStorage().repos.mcpServers;
  if (outcome.ok) {
    await repo.recordDeliverySuccess(id, outcome.atIso);
    return;
  }
  await repo.recordDeliveryFailure(id, outcome.category, outcome.atIso);
}
