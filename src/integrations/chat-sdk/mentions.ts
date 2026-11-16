/**
 * Mention handling for inbound chat text, over adapter payload shapes. No
 * database access; `botMentionForms` reads the Slack adapter's user cache.
 * Used by `inbound.ts` and `adapters.ts`.
 *
 * Each adapter renders the bot's own mention differently by the time the
 * handler sees the text (checked against the 4.45.0 adapter sources):
 * - Discord: `<@id>` / `<@!id>` becomes bare `@id`.
 * - Slack: `<@U…>` becomes `@<display name>` from `users.info`.
 * - Teams: `<at>Name</at>` becomes `@Name`, the name the client typed.
 * - Telegram and Rocket.Chat: `@username`, the adapter `userName`.
 */

import type { Adapter, Message } from "chat";

export interface BotMentionForms {
  /** Display names or handles; matched as `@name`, case-insensitive. */
  names: readonly string[];
  /** Platform user ids; matched as `<@id>`, `<@!id>` and bare `@id`. */
  ids: readonly string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove the bot's own mention in every form the adapters produce; other mentions stay. */
export function stripBotMention(text: string, forms: BotMentionForms): string {
  let out = text;
  const names = [...new Set(forms.names.map((name) => name.trim()).filter(Boolean))];
  // Longest first, so `@Agent Swarm` is not cut to ` Swarm` by an `@Agent` handle.
  names.sort((a, b) => b.length - a.length);
  for (const name of names) {
    out = out.replace(new RegExp(`(?<!\\w)@${escapeRegex(name)}(?![\\w-])`, "gi"), "");
  }
  for (const id of new Set(forms.ids.filter(Boolean))) {
    const escaped = escapeRegex(id);
    out = out.replace(new RegExp(`<@!?${escaped}>`, "g"), "");
    out = out.replace(new RegExp(`(?<![\\w<&])@${escaped}(?!\\w)`, "g"), "");
  }
  return out.trim();
}

/** The part of a Teams mention entity this reads. */
interface TeamsMentionEntity {
  type?: unknown;
  text?: unknown;
  mentioned?: { id?: unknown; name?: unknown };
}

/** Teams ids carry a channel prefix (`28:<appId>`); compare the part after the last colon. */
function teamsIdTail(id: string): string {
  return id.slice(id.lastIndexOf(":") + 1).toLowerCase();
}

/**
 * Names the bot was mentioned by in a Teams Activity: `mentioned.name` and
 * the `<at>…</at>` label of each mention entity that points at the bot.
 * The adapter renders that label as `@label`.
 */
export function teamsBotMentionNames(raw: unknown, botUserId: string | undefined): string[] {
  if (!botUserId || !raw || typeof raw !== "object") return [];
  const entities = (raw as { entities?: unknown }).entities;
  if (!Array.isArray(entities)) return [];
  const bot = teamsIdTail(botUserId);
  const names: string[] = [];
  for (const entity of entities as TeamsMentionEntity[]) {
    if (entity?.type !== "mention") continue;
    const id = entity.mentioned?.id;
    if (typeof id !== "string" || teamsIdTail(id) !== bot) continue;
    if (typeof entity.mentioned?.name === "string") names.push(entity.mentioned.name);
    if (typeof entity.text === "string") {
      const label = /<at\b[^>]*>(.*?)<\/at>/is.exec(entity.text)?.[1];
      if (label) names.push(decodeTeamsLabel(label));
    }
  }
  return names;
}

function decodeTeamsLabel(label: string): string {
  return label
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Name lookups for the ids in one Discord message. `undefined` keeps the id. */
export interface DiscordMentionLookup {
  user(id: string): string | undefined;
  role(id: string): string | undefined;
  channel(id: string): string | undefined;
}

/**
 * Rewrite Discord mention markup to names before the adapter parses it:
 * `<@id>` / `<@!id>` to `@name`, `<@&id>` to `@role`, `<#id>` to `#channel`.
 * The bot's own mention and any id without a name stay as markup, so the
 * adapter still turns them into `@id` / `#id` and no text is lost.
 */
export function resolveDiscordMentions(
  content: string,
  botUserId: string | undefined,
  lookup: DiscordMentionLookup,
): string {
  return content.replace(/<(@!?|@&|#)(\d+)>/g, (markup, kind: string, id: string) => {
    if (kind === "#") {
      const name = lookup.channel(id);
      return name ? `#${name}` : markup;
    }
    if (kind === "@&") {
      const name = lookup.role(id);
      return name ? `@${name}` : markup;
    }
    if (id === botUserId) return markup;
    const name = lookup.user(id);
    return name ? `@${name}` : markup;
  });
}

/** The part of a discord.js `Message` the lookup reads. */
export interface DiscordJsMentions {
  users?: { get(id: string): { displayName?: string; username?: string } | undefined };
  members?: { get(id: string): { displayName?: string } | undefined } | null;
  roles?: { get(id: string): { name?: string } | undefined };
  channels?: { get(id: string): object | undefined };
}

/** The part of a discord.js Gateway `Message` the swarm rewrites. */
export interface DiscordGatewayMessage {
  content: string;
  mentions?: DiscordJsMentions;
}

function safeName(read: () => unknown): string | undefined {
  try {
    const value = read();
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lookup over a Gateway message's `mentions` collections. Discord sends the
 * mentioned users (with guild member data) in the message; roles and
 * channels resolve from the guild cache the Guilds intent fills.
 */
export function discordJsMentionLookup(
  mentions: DiscordJsMentions | undefined,
): DiscordMentionLookup {
  return {
    user: (id) =>
      safeName(() => mentions?.members?.get(id)?.displayName) ??
      safeName(() => mentions?.users?.get(id)?.displayName) ??
      safeName(() => mentions?.users?.get(id)?.username),
    role: (id) => safeName(() => mentions?.roles?.get(id)?.name),
    channel: (id) =>
      safeName(() => (mentions?.channels?.get(id) as { name?: unknown } | undefined)?.name),
  };
}

/** The part of the Slack adapter used for the bot's own display name (protected in its types). */
type SlackUserLookup = {
  lookupUser?: (userId: string) => Promise<{ displayName?: string } | null>;
};

/**
 * Every form the bot's own mention takes in this message's text. Slack and
 * Teams render it under a display name that can differ from `userName`.
 */
export async function botMentionForms(
  adapter: Adapter,
  message: Message,
): Promise<BotMentionForms> {
  const names = [adapter.userName];
  const ids = adapter.botUserId ? [adapter.botUserId] : [];
  if (adapter.name === "teams") names.push(...teamsBotMentionNames(message.raw, adapter.botUserId));
  if (adapter.name === "slack" && adapter.botUserId) {
    const lookup = (adapter as Adapter & SlackUserLookup).lookupUser;
    // Cached by the adapter: it already looked the bot up to render the mention.
    const bot = await lookup?.call(adapter, adapter.botUserId).catch(() => null);
    if (bot?.displayName) names.push(bot.displayName);
  }
  return { names, ids };
}
