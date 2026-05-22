import { z } from "zod";

export const argsSchema = z.object({
  channelId: z.string().describe("Slack channel ID, e.g. 'C0AR967K0KZ'"),
  threadTs: z.string().describe("Thread timestamp (ts) of the root message"),
  token: z
    .string()
    .optional()
    .describe("Slack bot token override; falls back to the SLACK_BOT_TOKEN swarm config"),
});

async function resolveSecret(ctx: any, key: string, override: unknown): Promise<string | null> {
  if (typeof override === "string" && override.length > 0) return override;
  try {
    const base = ctx.stdlib.Redacted.value(ctx.swarm.config.mcpBaseUrl).replace(/\/+$/, "");
    const apiKey = ctx.stdlib.Redacted.value(ctx.swarm.config.apiKey);
    const res: any = await ctx.stdlib.fetchJson(
      base + "/api/config/resolved?includeSecrets=true",
      { headers: { Authorization: "Bearer " + apiKey } },
    );
    const configs: any = res && Array.isArray(res.configs) ? res.configs : [];
    for (const c of configs) {
      if (c && c.key === key && typeof c.value === "string" && c.value.length > 0) {
        return c.value;
      }
    }
  } catch {
    // Best-effort.
  }
  return null;
}

function tsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  return Number.isNaN(seconds) ? ts : new Date(seconds * 1000).toISOString();
}

/** Flatten a Slack thread into a readable, chronological transcript. */
export default async function slackThreadFlatten(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const { channelId, threadTs } = parsed.data;

  const token = await resolveSecret(ctx, "SLACK_BOT_TOKEN", parsed.data.token);
  if (!token) {
    return {
      error: "no Slack bot token available",
      hint: "set the SLACK_BOT_TOKEN swarm config or pass a 'token' arg",
    };
  }

  const url =
    "https://slack.com/api/conversations.replies?channel=" +
    encodeURIComponent(channelId) +
    "&ts=" +
    encodeURIComponent(threadTs) +
    "&limit=1000";
  const res: any = await ctx.stdlib.fetchJson(url, {
    headers: { Authorization: "Bearer " + token },
  });
  if (!res || res.ok !== true) {
    return { error: "Slack API error: " + (res && res.error ? res.error : "unknown") };
  }

  const raw: any = Array.isArray(res.messages) ? res.messages : [];
  const messages: any[] = raw.map((m: any) => ({
    author: m.username || m.user || m.bot_id || "unknown",
    text: typeof m.text === "string" ? m.text : "",
    ts: m.ts,
    at: m.ts ? tsToIso(m.ts) : null,
  }));
  messages.sort((a: any, b: any) => Number.parseFloat(a.ts || "0") - Number.parseFloat(b.ts || "0"));

  const transcript = messages
    .map((m: any) => "[" + (m.at || m.ts) + "] " + m.author + ": " + m.text)
    .join("\n");

  return {
    channelId,
    threadTs,
    messageCount: messages.length,
    hasMore: Boolean(res.has_more),
    transcript,
    messages,
  };
}
