#!/usr/bin/env bun
/**
 * Read-only report: lists the external (Slack Connect) channels the bot is in.
 *
 * External = is_ext_shared || is_pending_ext_shared, the same rule as
 * src/slack/external-channel.ts. Run it before you turn on
 * SLACK_BLOCK_EXTERNAL_CHANNELS.
 *
 * Usage: SLACK_BOT_TOKEN=xoxb-... bun scripts/slack-external-channel-report.ts
 *
 * Output: `total=<n> external=<n>`, then 1 line per external channel:
 * `id name is_private is_ext_shared is_pending_ext_shared`.
 */
import { WebClient } from "@slack/web-api";

type ChannelRow = {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
};

const token = process.env.SLACK_BOT_TOKEN?.trim();
if (!token) {
  console.error("SLACK_BOT_TOKEN is not set");
  process.exit(1);
}

const client = new WebClient(token);
let total = 0;
const external: ChannelRow[] = [];
let cursor: string | undefined;

do {
  const resp = await client.users.conversations({
    types: "public_channel,private_channel",
    exclude_archived: true,
    limit: 200,
    cursor,
  });
  const channels = (resp.channels ?? []) as ChannelRow[];
  total += channels.length;
  for (const ch of channels) {
    if (ch.is_ext_shared === true || ch.is_pending_ext_shared === true) external.push(ch);
  }
  cursor = resp.response_metadata?.next_cursor || undefined;
} while (cursor);

console.log(`total=${total} external=${external.length}`);
for (const ch of external) {
  console.log(
    [
      ch.id,
      ch.name,
      ch.is_private === true,
      ch.is_ext_shared === true,
      ch.is_pending_ext_shared === true,
    ].join(" "),
  );
}
