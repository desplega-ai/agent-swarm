import type { WebClient } from "@slack/web-api";
import { rememberSessionLabel } from "../be/db/session-labels";
import { getSlackApp } from "./app";
import { callSlackWithRetry, slackErrorCode } from "./render-v2";

const LABEL_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const FAILURE_CACHE_MAX = 500;
const inFlight = new Set<string>();
const failedUntil = new Map<string, number>();
let pending = Promise.resolve();

async function channelLabel(client: WebClient, id: string): Promise<string> {
  const result = await callSlackWithRetry(client, "conversations.info", {
    channel: id.toUpperCase(),
  });
  const channel = result.channel as
    | { name?: string; is_im?: boolean; is_mpim?: boolean; user?: string }
    | undefined;
  if (result.ok === false || !channel) throw new Error("Channel lookup failed");
  if (channel.is_mpim) return "Group DM";
  if (channel.is_im && channel.user) {
    const result = await callSlackWithRetry(client, "users.info", { user: channel.user });
    const user = result.user as
      | { profile?: { display_name?: string; real_name?: string }; real_name?: string }
      | undefined;
    const name = user?.profile?.display_name || user?.real_name || user?.profile?.real_name;
    if (result.ok !== false && name) return `DM · ${name}`;
  } else if (channel.name) {
    return `#${channel.name}`;
  }
  throw new Error("Channel label unavailable");
}

const CHANNEL_GROUP_KEY = /^shared\/slack\/([^/]+)\/$/;

/**
 * Queue a Slack lookup for each channel group key (`shared/slack/<channel>/`)
 * without delaying the tree response. Other keys are ignored.
 */
export function warmSlackChannelLabels(groupKeys: string[]): void {
  const client = getSlackApp()?.client;
  if (!client) return;
  for (const groupKey of groupKeys) {
    const id = CHANNEL_GROUP_KEY.exec(groupKey)?.[1];
    if (!id) continue;
    if (inFlight.has(id) || (failedUntil.get(id) ?? 0) > Date.now()) continue;
    failedUntil.delete(id);
    inFlight.add(id);
    pending = pending.then(async () => {
      try {
        const label = await channelLabel(client, id);
        await rememberSessionLabel(groupKey, label, LABEL_TTL_MS);
      } catch (error) {
        if (failedUntil.size >= FAILURE_CACHE_MAX) {
          const oldest = failedUntil.keys().next().value;
          if (oldest !== undefined) failedUntil.delete(oldest);
        }
        failedUntil.set(id, Date.now() + FAILURE_TTL_MS);
        console.warn(
          `[Slack] Could not cache a session channel label: ${slackErrorCode(error) ?? "unknown error"}`,
        );
      } finally {
        inFlight.delete(id);
      }
    });
  }
}
