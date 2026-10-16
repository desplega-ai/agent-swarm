import { webApi } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { type ChannelBlockReason, getChannelBlockReason } from "./external-channel";

/**
 * Client-level external-channel guard for every outbound Slack write.
 *
 * Tools, the watcher, render-v2 streaming, outcome cards, progress edits and
 * alerts all call `client.chat.*` / `filesUploadV2` directly, so the guard sits
 * on `WebClient` itself, like `egress-scrub.ts`. The prototype is patched
 * before any client is built, which covers Bolt's `app.client` and the
 * per-request clients it hands to listeners. A no-op unless
 * SLACK_BLOCK_EXTERNAL_CHANNELS is on.
 */

/** Methods that publish content into a channel, and the argument naming it. */
const GUARDED_METHODS: Record<string, readonly string[]> = {
  "chat.postMessage": ["channel"],
  "chat.postEphemeral": ["channel"],
  "chat.update": ["channel"],
  "chat.scheduleMessage": ["channel"],
  "chat.meMessage": ["channel"],
  "chat.startStream": ["channel"],
  "chat.appendStream": ["channel"],
  "chat.stopStream": ["channel"],
  "assistant.threads.setStatus": ["channel_id"],
  "assistant.threads.setSuggestedPrompts": ["channel_id"],
  "assistant.threads.setTitle": ["channel_id"],
  "files.completeUploadExternal": ["channel_id", "channels"],
};

/** Slack-shaped error codes, so delivery code classifies them like platform errors. */
export const EXTERNAL_CHANNEL_BLOCKED_CODE = "external_channel_blocked";
export const EXTERNAL_CHANNEL_UNVERIFIED_CODE = "external_channel_unverified";

type Args = Record<string, unknown>;

/** Channel IDs named by a write's arguments (`channels` may be comma-separated). */
function targetChannels(fields: readonly string[], args: Args | undefined): string[] {
  if (!args) return [];
  const out: string[] = [];
  for (const field of fields) {
    const value = args[field];
    if (typeof value !== "string") continue;
    for (const id of value.split(",")) {
      const trimmed = id.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function blockedError(method: string, channelId: string, reason: ChannelBlockReason): Error {
  const code =
    reason === "external" ? EXTERNAL_CHANNEL_BLOCKED_CODE : EXTERNAL_CHANNEL_UNVERIFIED_CODE;
  const error = new Error(
    `An API error occurred: ${code} (${method} to ${channelId} refused by SLACK_BLOCK_EXTERNAL_CHANNELS)`,
  );
  return Object.assign(error, {
    code: webApi.ErrorCode.PlatformError,
    data: { ok: false, error: code },
  });
}

async function assertChannelsAllowed(
  client: WebClient,
  method: string,
  channels: string[],
): Promise<void> {
  for (const channelId of channels) {
    const reason = await getChannelBlockReason(client, channelId);
    if (reason) {
      console.warn(`[Slack] Refused ${method} to ${channelId} (${reason})`);
      throw blockedError(method, channelId, reason);
    }
  }
}

const INSTALLED = Symbol.for("agent-swarm.slack-external-channel-guard");

type PatchableProto = {
  apiCall: (method: string, options?: Args) => Promise<unknown>;
  filesUploadV2: (options: Args) => Promise<unknown>;
  [INSTALLED]?: true;
};

/**
 * Route every `WebClient` built after this call through the guard. Idempotent.
 * Call it before the Bolt `App` (and its receiver) are constructed.
 */
export function installSlackExternalChannelGuard(): void {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- we patch private WebClient prototype methods.
  const proto = webApi.WebClient.prototype as unknown as PatchableProto;
  if (proto[INSTALLED]) return;
  const originalApiCall = proto.apiCall;
  const originalUpload = proto.filesUploadV2;
  proto.apiCall = async function (this: WebClient, method: string, options?: Args) {
    const fields = GUARDED_METHODS[method];
    if (fields) await assertChannelsAllowed(this, method, targetChannels(fields, options));
    return originalApiCall.call(this, method, options);
  };
  // Check before the bytes leave: completeUploadExternal is guarded too, but by
  // then the file already sits in Slack storage.
  proto.filesUploadV2 = async function (this: WebClient, options: Args) {
    await assertChannelsAllowed(
      this,
      "files.uploadV2",
      targetChannels(["channel_id", "channels"], options),
    );
    return originalUpload.call(this, options);
  };
  proto[INSTALLED] = true;
}
