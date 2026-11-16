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
import { type IdentityResolution, resolveIdentity } from "../be/identity";
import { recordUnmappedIdentity } from "../be/unmapped-identities";
import {
  findOrCreateUserByEmail,
  findUserByEmail,
  findUserByExternalId,
  type IdentityActor,
  linkIdentity,
} from "../be/users";
import type { SlackParticipantTrust } from "../types";

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
  const cached = await getKv(ENRICHMENT_NAMESPACE, slackUserId);
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

  await upsertKv({
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
 * Company email domains, read at call time so a config edit applies without a
 * restart. `COMPANY_EMAIL_DOMAINS` wins; unset, it falls back to
 * `SLACK_ALLOWED_EMAIL_DOMAINS`, which in practice lists the same domains.
 */
export function getCompanyEmailDomains(): string[] {
  const raw = process.env.COMPANY_EMAIL_DOMAINS?.trim()
    ? process.env.COMPANY_EMAIL_DOMAINS
    : process.env.SLACK_ALLOWED_EMAIL_DOMAINS;
  return (raw ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

function isCompanyEmail(email: string, domains: string[]): boolean {
  const domain = email.split("@").pop()?.toLowerCase();
  return !!domain && domains.includes(domain);
}

export interface SlackParticipantResolution {
  userId?: string;
  trust: SlackParticipantTrust;
}

/**
 * Map a Slack user to a canonical `users.id` and a trust level:
 *
 *   1. Existing `(slack, <userId>)` alias, else the Slack profile email.
 *   2. A company-domain email links or creates the user (`role: "member"`);
 *      any other email links an existing user and never creates one. A sender
 *      from another Slack team is never linked by email.
 *   3. No email: recorded in the unmapped tracker, trust `unknown`.
 *
 * Trust: `users.metadata.audience` wins; then another Slack team (see
 * `isOurSlackTeam`) is external; then the email domain decides, and
 * no email is `unknown`. With no company domains configured, linked users are
 * internal and nobody is created.
 */
export async function resolveSlackParticipant(
  client: WebClient,
  slackUserId: string,
  eventContext: {
    sampleEventType: string;
    sampleContext: string;
    userTeam?: string;
  },
): Promise<SlackParticipantResolution> {
  const domains = getCompanyEmailDomains();
  const sameTeam = eventContext.userTeam
    ? await isOurSlackTeam(client, eventContext.userTeam, slackUserId)
    : undefined;
  const foreignTeam = sameTeam === false;

  let user = await findUserByExternalId("slack", slackUserId);
  const email = user?.email || (await enrichSlackUserEmail(client, slackUserId));

  // Another team's profile email is set by that team, not verified as owned by
  // this sender, so it never links to an existing user. An operator can link
  // the alias by hand. With our own team unknown (`auth.test` failed), a sender
  // that carries a team is not linked either, and its email grants no trust.
  const linkable = !eventContext.userTeam || sameTeam === true;
  if (!user && email && linkable) {
    if (isCompanyEmail(email, domains)) {
      // Pull the cached name back out for the user-row hints. The kv read is
      // cheap (single primary-key lookup) and avoids a second `users.info`.
      const cached = await getKv(ENRICHMENT_NAMESPACE, slackUserId);
      const name = (cached?.value as EnrichedSlackUser | undefined)?.name ?? undefined;
      user = (await findOrCreateUserByEmail(email, { name, role: "member" }, SLACK_WEBHOOK_ACTOR))
        .user;
    } else {
      // Attribution only: an outside email never creates a user row.
      user = await findUserByEmail(email);
    }
    if (user) {
      // A concurrent enroll can win the `(slack, <id>)` PK; guard so the
      // webhook does not 500, then trust the alias row below.
      try {
        await linkIdentity(user.id, "slack", slackUserId, SLACK_WEBHOOK_ACTOR);
      } catch (error) {
        console.warn(
          `[Slack] linkIdentity('slack', ${slackUserId}) failed — likely a concurrent enroll`,
          error,
        );
      }
      user = (await findUserByExternalId("slack", slackUserId)) ?? user;
    }
  }

  if (!user && !email) {
    await recordUnmappedIdentity("slack", slackUserId, eventContext);
  }

  const audience = (user?.metadata as { audience?: unknown } | undefined)?.audience;
  const trust: SlackParticipantTrust =
    audience === "internal" || audience === "external"
      ? audience
      : foreignTeam
        ? "external"
        : // Own team unknown: the sender's team may be foreign, so its email proves nothing.
          eventContext.userTeam && sameTeam === undefined
          ? "unknown"
          : domains.length === 0
            ? user
              ? "internal"
              : email
                ? "external"
                : "unknown"
            : !email
              ? "unknown"
              : isCompanyEmail(email, domains)
                ? "internal"
                : "external";
  return { userId: user?.id, trust };
}

/**
 * The canonical `users.id` for a Slack user, or `undefined` (task creation
 * then proceeds without a `requestedByUserId`). See `resolveSlackParticipant`.
 */
export async function resolveSlackUserId(
  client: WebClient,
  slackUserId: string,
  // `userTeam` is required (pass `undefined` when the event has none) so no
  // call site can silently drop it: a Slack Connect sender with a company
  // email must not get a member row.
  eventContext: { sampleEventType: string; sampleContext: string; userTeam: string | undefined },
): Promise<string | undefined> {
  return (await resolveSlackParticipant(client, slackUserId, eventContext)).userId;
}

interface OurSlackTeam {
  teamId?: string;
  enterpriseId?: string;
  /** Installed on the whole Enterprise Grid org, not one workspace. */
  orgInstall: boolean;
}

/** Our own Slack team (`auth.test`), cached per process once it names a team. */
let cachedTeam: OurSlackTeam | undefined;
async function getOurSlackTeam(client: WebClient): Promise<OurSlackTeam | undefined> {
  if (cachedTeam) return cachedTeam;
  try {
    const result = await client.auth.test();
    const teamId = result.team_id || undefined;
    const enterpriseId = result.enterprise_id || undefined;
    // Slack does not document `team_id` for an org-wide install; it may be absent or
    // the enterprise id. Either way a sender's `user_team` is a workspace id.
    const orgInstall =
      result.is_enterprise_install === true ||
      (!!enterpriseId && (!teamId || teamId === enterpriseId));
    if (teamId || enterpriseId) cachedTeam = { teamId, enterpriseId, orgInstall };
  } catch (error) {
    console.error("[Slack] auth.test failed while reading the team id:", error);
  }
  return cachedTeam;
}

/** Reset the team cache between tests. */
export function resetSlackTeamIdCacheForTesting(): void {
  cachedTeam = undefined;
}

/**
 * A Slack user's workspace (`users.info` `user.team_id`) and Enterprise Grid org, or
 * `undefined` when the lookup fails.
 * shortcut: uncached, as it runs only for events without `user_team` and org-wide
 * installs; cache it next to the email if `users.info` rate limits show up.
 */
export async function getSlackUserTeam(
  client: WebClient,
  slackUserId: string,
): Promise<{ teamId?: string; enterpriseId?: string } | undefined> {
  try {
    const { user } = await client.users.info({ user: slackUserId });
    if (!user) return undefined;
    return {
      teamId: user.team_id || undefined,
      enterpriseId: user.enterprise_user?.enterprise_id || undefined,
    };
  } catch (error) {
    console.error(`[Slack] users.info failed while reading the team of ${slackUserId}:`, error);
    return undefined;
  }
}

/**
 * Whether a sender on Slack team `userTeam` is on our Slack team: `undefined` when
 * our own team is unknown (`auth.test` failed). A workspace install compares team
 * ids. An org-wide install compares the sender's Enterprise Grid org, and a sender
 * whose org cannot be read is not ours.
 */
export async function isOurSlackTeam(
  client: WebClient,
  userTeam: string,
  slackUserId: string,
): Promise<boolean | undefined> {
  const ours = await getOurSlackTeam(client);
  if (!ours) return undefined;
  if (userTeam === ours.teamId) return true;
  if (!ours.orgInstall) return false;
  const sender = await getSlackUserTeam(client, slackUserId);
  return !!sender?.enterpriseId && sender.enterpriseId === ours.enterpriseId;
}

/**
 * Rewrite every Slack `<@USERID>` mention token in `text` via the identity
 * primitive: `<@USERID|Name>` when resolved, `<@USERID> (unknown user)` when
 * not. Covers both author labels (`<@U…>: message`) and mentions embedded in
 * message bodies — both are just this same token. Pure DB reads via
 * `resolveIdentity`; zero Slack API calls, no cache.
 */
export async function rewriteSlackMentions(
  text: string,
  botUserId?: string,
  trust?: ReadonlyMap<string, SlackParticipantTrust>,
): Promise<string> {
  const userIds = new Set<string>();
  for (const match of text.matchAll(/<@([A-Z0-9]+)>/g)) {
    const userId = match[1];
    if (userId && userId !== botUserId) userIds.add(userId);
  }

  const resolutions = new Map<string, IdentityResolution>();
  await Promise.all(
    [...userIds].map(async (userId) => {
      resolutions.set(userId, await resolveIdentity("slack", userId));
    }),
  );

  return text.replace(/<@([A-Z0-9]+)>/g, (_match, userId: string) => {
    if (userId === botUserId) return `<@${userId}> (that's you)`;
    const resolution = resolutions.get(userId);
    const level = trust?.get(userId);
    const untrusted = level === "external" || level === "unknown" ? level : undefined;
    if (resolution?.status === "resolved") {
      return untrusted
        ? `<@${userId}|${resolution.name}> (${untrusted}, untrusted)`
        : `<@${userId}|${resolution.name}>`;
    }
    return untrusted ? `<@${userId}> (unknown user, untrusted)` : `<@${userId}> (unknown user)`;
  });
}
