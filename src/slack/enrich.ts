/**
 * Slack-side identity enrichment + resolution cascade.
 *
 * Two helpers — together they replace the in-process email-lookup Map that
 * previously lived in `src/slack/handlers.ts` (Q17.E):
 *
 *   * `enrichSlackUserEmail(slackUserId)` — kv-backed cache of the user's
 *     email + display name from `client.users.info`. 24h TTL on success;
 *     failures are NEVER cached so rate-limit recovery just works on retry.
 *
 *   * `resolveSlackUserId(client, slackUserId, ctx)` — the three-step cascade
 *     each Slack webhook entry point uses to map a Slack user to a canonical
 *     `users.id`:
 *
 *       1. `findUserByExternalId('slack', slackUserId)` — fast path.
 *       2. On miss: enrich → `findOrCreateUserByEmail` + `linkIdentity`.
 *       3. On no-email: record into the kv unmapped tracker. Returns
 *          `undefined` — task creation proceeds without a `requestedByUserId`.
 *
 * Both helpers are API-side (live under `src/slack/` which is API-only) — they
 * may import from `src/be/`.
 */

import type { WebClient } from "@slack/web-api";
import { getKv, upsertKv } from "../be/db";
import { resolveIdentity } from "../be/identity";
import { recordUnmappedIdentity } from "../be/unmapped-identities";
import {
  findOrCreateUserByEmail,
  findUserByExternalId,
  type IdentityActor,
  linkIdentity,
} from "../be/users";

const ENRICHMENT_NAMESPACE = "integration:user-enrichment:slack";
const ENRICHMENT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Persisted enrichment payload. `email: null` cases are NEVER stored — see
 * Q17.E. We keep `name` so future People-page renders don't need to refetch.
 */
interface EnrichedSlackUser {
  email: string;
  name: string | null;
  fetchedAt: string;
}

/**
 * Fetch a Slack user's email, caching successful results for 24h in the
 * `integration:user-enrichment:slack` kv namespace.
 *
 * Returns `null` (without caching) when:
 *   * `client.users.info` throws (network / 5xx / rate-limit).
 *   * The profile is missing `profile.email` (bot accounts, restricted users).
 *
 * Caching null would defeat retry-on-recovery, so we intentionally skip the
 * cache write on every failure path.
 */
export async function enrichSlackUserEmail(
  client: WebClient,
  slackUserId: string,
): Promise<string | null> {
  // Cache hit — return the persisted email straight through.
  const cached = getKv(ENRICHMENT_NAMESPACE, slackUserId);
  if (cached !== null) {
    const payload = cached.value as EnrichedSlackUser;
    if (payload?.email) {
      return payload.email;
    }
    // Defensive: if a stale row landed without email somehow, fall through to
    // refetch rather than handing back `null` from cache.
  }

  // Cache miss — hit the Slack API.
  let email: string | null = null;
  let name: string | null = null;
  try {
    const result = await client.users.info({ user: slackUserId });
    email = result.user?.profile?.email ?? null;
    name = result.user?.profile?.real_name ?? result.user?.real_name ?? null;
  } catch (error) {
    console.error(`[Slack] enrichSlackUserEmail failed for ${slackUserId}:`, error);
    return null;
  }

  if (!email) {
    // Q17.E: do NOT cache the no-email case.
    return null;
  }

  upsertKv({
    namespace: ENRICHMENT_NAMESPACE,
    key: slackUserId,
    value: {
      email,
      name,
      fetchedAt: new Date().toISOString(),
    } satisfies EnrichedSlackUser,
    valueType: "json",
    expiresAt: Date.now() + ENRICHMENT_TTL_MS,
  });

  return email;
}

/** Audit-trail actor for the auto-link cascade. */
const SLACK_WEBHOOK_ACTOR: IdentityActor = { kind: "system", id: "webhook:slack" };

/**
 * Three-step cascade used by every Slack webhook entry point to map a Slack
 * user ID to a canonical `users.id`:
 *
 *   1. Look up the existing `(slack, <userId>)` mapping in `user_external_ids`.
 *   2. If missing, enrich the Slack profile to extract an email; if found,
 *      auto-link via `findOrCreateUserByEmail` + `linkIdentity`. Emits an
 *      `auto_merge` (existing user) or `identity_added` (new user) event,
 *      followed by an `identity_added` event for the Slack alias itself.
 *   3. If no email is recoverable, record into the kv unmapped tracker so the
 *      operator can triage manually. Returns `undefined` — task creation
 *      proceeds without `requestedByUserId`.
 *
 * `eventContext` shapes the sample written to the unmapped tracker — the
 * sample is truncated to 100 chars inside `recordUnmappedIdentity`.
 */
export async function resolveSlackUserId(
  client: WebClient,
  slackUserId: string,
  eventContext: { sampleEventType: string; sampleContext: string },
): Promise<string | undefined> {
  // 1. Fast path — existing alias.
  const existing = findUserByExternalId("slack", slackUserId);
  if (existing) return existing.id;

  // 2. Enrich → auto-link by email.
  const email = await enrichSlackUserEmail(client, slackUserId);
  if (email) {
    // Pull the cached name back out for the user-row hints. The kv read is
    // cheap (single primary-key lookup) and avoids a second `users.info`.
    const cached = getKv(ENRICHMENT_NAMESPACE, slackUserId);
    const name = (cached?.value as EnrichedSlackUser | undefined)?.name ?? undefined;

    const { user } = findOrCreateUserByEmail(email, { name }, SLACK_WEBHOOK_ACTOR);

    // Link the Slack identity to whichever user we resolved to. PK collision
    // on `(slack, <id>)` shouldn't happen — we just confirmed no existing
    // mapping in step 1 — but guard defensively so a race doesn't 500 the
    // webhook.
    try {
      linkIdentity(user.id, "slack", slackUserId, SLACK_WEBHOOK_ACTOR);
    } catch (error) {
      console.warn(
        `[Slack] linkIdentity('slack', ${slackUserId}) failed — likely a concurrent enroll`,
        error,
      );
    }

    return user.id;
  }

  // 3. No email — track as unmapped.
  recordUnmappedIdentity("slack", slackUserId, eventContext);
  return undefined;
}

/**
 * Rewrite every Slack `<@USERID>` mention token in `text` via the identity
 * primitive: `<@USERID|Name>` when resolved, `<@USERID> (unknown user)` when
 * not. Covers both author labels (`<@U…>: message`) and mentions embedded in
 * message bodies — both are just this same token. Pure DB reads via
 * `resolveIdentity`; zero Slack API calls, no cache.
 */
export function rewriteSlackMentions(text: string): string {
  return text.replace(/<@([A-Z0-9]+)>/g, (_match, userId: string) => {
    const resolution = resolveIdentity("slack", userId);
    return resolution.status === "resolved"
      ? `<@${userId}|${resolution.name}>`
      : `<@${userId}> (unknown user)`;
  });
}
