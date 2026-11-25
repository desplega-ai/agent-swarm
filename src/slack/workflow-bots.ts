/**
 * `SLACK_WORKFLOW_BOT_IDS`: Slack bots whose posts start `slack.message`
 * workflows, per channel.
 *
 * The value is a comma-separated list of `CHANNEL_ID:BOT_ID` pairs, for
 * example `C0123ABCD:B0SENTRY1,C0123ABCD:B0DDOG001`. Unset or empty keeps the
 * default: every bot message is dropped. A listed bot post only emits the
 * workflow event; it never reaches agent routing or task creation.
 *
 * Read on each call so a dashboard change applies without a restart. This
 * module imports nothing, so the config guard can use it.
 */

export const SLACK_WORKFLOW_BOT_IDS_KEY = "SLACK_WORKFLOW_BOT_IDS";

const SLACK_ID = /^[A-Z0-9]{2,}$/;

type ParsedPairs = { pairs: Set<string>; invalid: string[] };

function parsePairs(raw: string): ParsedPairs {
  const pairs = new Set<string>();
  const invalid: string[] = [];
  for (const entry of raw.split(",")) {
    const item = entry.trim();
    if (!item) continue;
    const [channel, bot, ...rest] = item.split(":").map((part) => part.trim());
    if (rest.length > 0 || !channel || !bot || !SLACK_ID.test(channel) || !SLACK_ID.test(bot)) {
      invalid.push(item);
      continue;
    }
    pairs.add(`${channel}:${bot}`);
  }
  return { pairs, invalid };
}

/** Config-guard validator: rejects any entry that is not `CHANNEL_ID:BOT_ID`. */
export function validateSlackWorkflowBotIds(value: unknown): string | null {
  if (typeof value !== "string") return `Invalid ${SLACK_WORKFLOW_BOT_IDS_KEY} (must be a string)`;
  const { invalid } = parsePairs(value);
  if (invalid.length === 0) return null;
  return `Invalid ${SLACK_WORKFLOW_BOT_IDS_KEY} entry "${invalid[0]}" (use comma-separated CHANNEL_ID:BOT_ID pairs, e.g. C0123ABCD:B0123ABCD)`;
}

/**
 * True when this bot post may start `slack.message` workflows. The swarm's own
 * bot never qualifies, even when listed, so its replies cannot loop. With the
 * own bot id unknown the check fails closed.
 */
export function isSlackWorkflowBotAllowed(
  event: { channel?: string; bot_id?: string; user?: string },
  own: { botId: string | null; botUserId: string | null },
  raw: string | undefined = process.env[SLACK_WORKFLOW_BOT_IDS_KEY],
): boolean {
  if (!raw?.trim() || !event.channel || !event.bot_id) return false;
  if (!own.botId || !own.botUserId) return false;
  if (event.bot_id === own.botId || event.user === own.botUserId) return false;
  return parsePairs(raw).pairs.has(`${event.channel}:${event.bot_id}`);
}
