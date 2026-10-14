import type { WebClient } from "@slack/web-api";
import { claimKv, deleteKv, sweepExpiredKv, upsertKv } from "../be/db";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { scrubSecrets } from "../utils/secret-scrubber";
import { slackCode, slackMissingScopeMessage } from "./channel-join";

/**
 * External (Slack Connect) channel detection and enforcement.
 *
 * A channel is external when `conversations.info` returns `is_ext_shared` or
 * `is_pending_ext_shared`, or when the event envelope carries
 * `is_ext_shared_channel: true`. `is_shared` / `is_org_shared` alone are
 * internal (Enterprise Grid org-shared channels).
 *
 * `SLACK_BLOCK_EXTERNAL_CHANNELS` is read at call time so a dashboard change
 * applies without a restart.
 */

export type ChannelExternality = "external" | "internal" | "unknown";
export type ExternalChannelTrigger = "joined" | "shared" | "boot-scan";
/** Why a channel is blocked: Slack says it is external, or Slack could not confirm it is not. */
export type ChannelBlockReason = "external" | "unverified";

const EXTERNALITY_TTL_MS = 10 * 60 * 1000;
const EXTERNALITY_CACHE_MAX = 500;
const ALERT_DEDUPE_MS = 60 * 60 * 1000;
/** A reservation whose post never settles (crash mid-post) frees the key after this. */
const ALERT_SENDING_TTL_MS = 2 * 60 * 1000;
/** Durable alert dedupe in kv_entries, so a restart does not repeat alerts. */
export const EXTERNAL_ALERT_KV_NAMESPACE = "slack-external-alert";

const externalityCache = new Map<string, { value: "external" | "internal"; expiresAt: number }>();
// Bumped on every invalidation or positive external evidence. A lookup that
// started under an older generation must not overwrite the newer state.
const channelGeneration = new Map<string, number>();
let generationCounter = 0;

export const EXTERNAL_CHANNEL_BLOCKED_REPLY =
  "This channel is shared with another organization. The swarm does not work here.";

export function externalChannelToolError(
  channelId: string,
  reason: ChannelBlockReason = "external",
): string {
  if (reason === "unverified") {
    return `Could not verify that channel ${channelId} is internal to this organization. SLACK_BLOCK_EXTERNAL_CHANNELS blocks swarm messages there until Slack confirms it. Try again later.`;
  }
  return `Channel ${channelId} is shared with another organization. SLACK_BLOCK_EXTERNAL_CHANNELS blocks swarm messages there.`;
}

export function isBlockExternalEnabled(): boolean {
  return isEnvFlagEnabled("SLACK_BLOCK_EXTERNAL_CHANNELS", false);
}

/** Reset in-memory caches between tests. Durable alert state lives in kv_entries. */
export function resetExternalChannelStateForTesting(): void {
  externalityCache.clear();
  channelGeneration.clear();
}

/** Insert into an insertion-ordered Map, evicting the oldest entry at the cap. */
function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  if (map.size >= EXTERNALITY_CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function bumpGeneration(channelId: string): void {
  generationCounter += 1;
  setBounded(channelGeneration, channelId, generationCounter);
}

export function invalidateChannelExternality(channelId: string): void {
  externalityCache.delete(channelId);
  bumpGeneration(channelId);
}

/**
 * Records positive evidence that a channel is external (for example an event
 * envelope with `is_ext_shared_channel: true`), so later outbound checks block
 * without waiting for the cached internal value to expire.
 */
export function recordExternalChannel(channelId: string): void {
  bumpGeneration(channelId);
  setBounded(externalityCache, channelId, {
    value: "external",
    expiresAt: Date.now() + EXTERNALITY_TTL_MS,
  });
}

/**
 * Looks up whether a channel is external. Known results are cached for 10
 * minutes; an API error returns "unknown" and is not cached. A result whose
 * channel was invalidated or marked external while the lookup was in flight
 * is not cached: the newer state wins, and an invalidated lookup returns
 * "unknown".
 */
export async function getChannelExternality(
  client: WebClient,
  channelId: string,
): Promise<ChannelExternality> {
  const cached = externalityCache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) externalityCache.delete(channelId);

  const generation = channelGeneration.get(channelId);
  let value: "external" | "internal";
  try {
    const resp = await client.conversations.info({ channel: channelId });
    const ch = (resp.channel ?? {}) as {
      is_ext_shared?: boolean;
      is_pending_ext_shared?: boolean;
    };
    value =
      ch.is_ext_shared === true || ch.is_pending_ext_shared === true ? "external" : "internal";
  } catch (error) {
    console.warn(
      `[Slack] conversations.info failed for ${channelId}:`,
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
    return "unknown";
  }

  if (channelGeneration.get(channelId) !== generation) {
    const fresher = externalityCache.get(channelId);
    if (fresher && fresher.expiresAt > Date.now()) return fresher.value;
    return value === "external" ? "external" : "unknown";
  }
  setBounded(externalityCache, channelId, { value, expiresAt: Date.now() + EXTERNALITY_TTL_MS });
  return value;
}

/**
 * Returns why the swarm must not touch a channel, or null when it may. With the
 * flag on, a channel Slack cannot classify is blocked as "unverified" (fail
 * closed): disclosing swarm output across an unverified boundary is worse than
 * a temporary refusal.
 */
export async function getChannelBlockReason(
  client: WebClient,
  channelId: string,
  envelopeFlag?: boolean,
): Promise<ChannelBlockReason | null> {
  if (!isBlockExternalEnabled()) return null;
  if (envelopeFlag === true) {
    recordExternalChannel(channelId);
    return "external";
  }
  const externality = await getChannelExternality(client, channelId);
  if (externality === "external") return "external";
  if (externality === "unknown") {
    console.warn(
      `[Slack] Could not tell if channel ${channelId} is external; blocking (fail closed)`,
    );
    return "unverified";
  }
  return null;
}

/** True when the flag is on and the channel is external or cannot be verified. */
export async function shouldBlockChannel(
  client: WebClient,
  channelId: string,
  envelopeFlag?: boolean,
): Promise<boolean> {
  return (await getChannelBlockReason(client, channelId, envelopeFlag)) !== null;
}

async function postExternalChannelAlert(
  client: WebClient,
  channelId: string,
  trigger: ExternalChannelTrigger,
  leave: string,
  scopeHint?: string,
): Promise<void> {
  const alertsChannel = process.env.SLACK_ALERTS_CHANNEL?.trim();
  if (!alertsChannel) {
    console.warn("[Slack] SLACK_ALERTS_CHANNEL not set; skipping external channel alert");
    return;
  }

  // Durable dedupe: reserve the key briefly, extend it to an hour only after
  // Slack accepts the post, and release it when the post fails.
  const key = `${channelId}:${trigger}`;
  if (!(await reserveAlert(key))) return;

  const lines = [
    `:no_entry: Swarm bot in external Slack channel <#${channelId}> (${channelId})`,
    `Trigger: ${trigger}`,
    `Leave: ${leave}`,
    ...(scopeHint ? [scopeHint] : []),
    "Inbound guard: active. The swarm creates no task from this channel.",
  ];

  try {
    await client.chat.postMessage({
      channel: alertsChannel,
      text: scrubSecrets(lines.join("\n")),
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    console.error(
      "[Slack] Failed to send external channel alert:",
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
    await settleAlert(key, false);
    return;
  }
  await settleAlert(key, true);
}

/** True when this caller may send the alert. A DB failure sends rather than suppresses. */
async function reserveAlert(key: string): Promise<boolean> {
  try {
    return await claimKv({
      namespace: EXTERNAL_ALERT_KV_NAMESPACE,
      key,
      value: "sending",
      valueType: "string",
      expiresAt: Date.now() + ALERT_SENDING_TTL_MS,
    });
  } catch (error) {
    console.warn("[Slack] External channel alert dedupe unavailable:", error);
    return true;
  }
}

async function settleAlert(key: string, sent: boolean): Promise<void> {
  try {
    if (sent) {
      await upsertKv({
        namespace: EXTERNAL_ALERT_KV_NAMESPACE,
        key,
        value: "sent",
        valueType: "string",
        expiresAt: Date.now() + ALERT_DEDUPE_MS,
      });
    } else {
      await deleteKv(EXTERNAL_ALERT_KV_NAMESPACE, key);
    }
  } catch (error) {
    console.warn("[Slack] Failed to record external channel alert state:", error);
  }
}

/** Leaves an external channel and posts one alert with the result. */
export async function leaveExternalChannel(
  client: WebClient,
  channelId: string,
  reason: "joined" | "shared",
): Promise<void> {
  let leave: string;
  let scopeHint: string | undefined;
  try {
    // A bot that is not a member gets {"ok":false,"not_in_channel":true}; treat it as left.
    await client.conversations.leave({ channel: channelId });
    leave = "left";
  } catch (error) {
    const code = slackCode(error);
    const notInChannel =
      code === "not_in_channel" ||
      (error as { data?: { not_in_channel?: boolean } })?.data?.not_in_channel === true;
    if (notInChannel) {
      leave = "left";
    } else {
      leave = `failed (${code ?? "unknown_error"})`;
      if (code === "missing_scope") scopeHint = slackMissingScopeMessage(error);
      console.error(`[Slack] Failed to leave external channel ${channelId}: ${leave}`);
    }
  }
  if (leave === "left") console.log(`[Slack] Left external channel ${channelId} (${reason})`);
  await postExternalChannelAlert(client, channelId, reason, leave, scopeHint);
}

/**
 * Boot scan, report only: posts one alert per external channel the bot is in.
 * It never leaves a channel; a human decides.
 */
export async function scanExternalChannelsOnBoot(client: WebClient): Promise<void> {
  if (!isBlockExternalEnabled()) return;

  // kv_entries has no background sweep; drop expired alert keys so the namespace stays bounded.
  await sweepExpiredKv(EXTERNAL_ALERT_KV_NAMESPACE).catch((error) => {
    console.warn("[Slack] Failed to sweep expired external channel alert keys:", error);
  });

  let cursor: string | undefined;
  do {
    const resp = await client.users.conversations({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const ch of (resp.channels ?? []) as Array<{
      id?: string;
      is_ext_shared?: boolean;
      is_pending_ext_shared?: boolean;
    }>) {
      if (!ch.id || !(ch.is_ext_shared === true || ch.is_pending_ext_shared === true)) continue;
      await postExternalChannelAlert(client, ch.id, "boot-scan", "not attempted (report only)");
    }
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);
}
