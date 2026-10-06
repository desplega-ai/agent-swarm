/**
 * Slack text as people read it. Slack-sourced task prompts keep Slack's wire
 * tokens (`<@U123|Taras>`, `<#C1|general>`, `<https://x|label>`) plus the
 * swarm's own annotations from `rewriteSlackMentions` (`(that's you)`,
 * `(unknown user)`) and the `<thread_context>` wrapper. The backend helpers
 * live in `src/slack/` and import the database, so the dashboard keeps its own
 * pure copy of the parsing here.
 */

/** A message in the Slack thread that came before the ask. */
interface SlackThreadMessage {
  /** Display name. `undefined` when the author is not resolved. */
  speaker?: string;
  /** Raw message text. Slack tokens stay: format it with `formatSlackMentions`. */
  text: string;
}

export interface SlackPrompt {
  /** The prompt without the thread context and the leading speaker prefix. Slack tokens stay. */
  ask: string;
  /** Who asked, from a leading `<@ID|Name>: ` prefix. `undefined` when absent or unresolved. */
  speaker?: string;
  /** Earlier thread messages from the `<thread_context>` block, oldest first. */
  thread: SlackThreadMessage[];
}

const SELF_MENTION = /<@[A-Z0-9]+(?:\|[^>]*)?>\s*\(that['’]s you\)[ \t]?/g;
const UNKNOWN_MENTION = /<@[A-Z0-9]+>\s*\(unknown user\)/g;
const NAMED_MENTION = /<@[A-Z0-9]+\|([^>]+)>/g;
const BARE_MENTION = /<@[A-Z0-9]+>/g;
const NAMED_CHANNEL = /<#[A-Z0-9]+\|([^>]+)>/g;
const BARE_CHANNEL = /<#[A-Z0-9]+>/g;
const SPECIAL_MENTION = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;
const GROUP_MENTION = /<!subteam\^[A-Z0-9]+\|([^>]+)>/g;
const LABELED_LINK = /<((?:https?|mailto):[^|>\s]+)\|([^>]+)>/g;
const BARE_LINK = /<((?:https?|mailto):[^|>\s]+)>/g;

/**
 * Turn Slack tokens into readable text:
 * - `<@ID|Name>` becomes `@Name`.
 * - `<@ID> (that's you)` (the swarm's own bot) is removed.
 * - `<@ID> (unknown user)` and a bare `<@ID>` become `@someone`.
 * - `<#ID|name>` becomes `#name`, and a bare `<#ID>` becomes `#channel`.
 * - `<url|label>` becomes `label`, and a bare `<url>` becomes `url`.
 * - `<!here>`, `<!channel>` and `<!everyone>` become `@here`, `@channel` and `@everyone`.
 *
 * Text with no Slack tokens comes back unchanged.
 */
export function formatSlackMentions(text: string): string {
  return text
    .replace(SELF_MENTION, "")
    .replace(UNKNOWN_MENTION, "@someone")
    .replace(NAMED_MENTION, (_match, name: string) => `@${name.trim()}`)
    .replace(BARE_MENTION, "@someone")
    .replace(NAMED_CHANNEL, (_match, name: string) => `#${name.trim()}`)
    .replace(BARE_CHANNEL, "#channel")
    .replace(SPECIAL_MENTION, (_match, name: string) => `@${name}`)
    .replace(GROUP_MENTION, (_match, label: string) => label.trim())
    .replace(LABELED_LINK, (_match, _url: string, label: string) => label.trim())
    .replace(BARE_LINK, (_match, url: string) => url);
}

const THREAD_CONTEXT = /<thread_context>([\s\S]*?)<\/thread_context>/g;

/** `<@ID|Name>: ` or `<@ID> (unknown user): ` at the start of the ask. */
const ASK_SPEAKER = /^(<@[A-Z0-9]+(?:\|[^>]*)?>(?:\s*\(unknown user\))?):\s?/;
/**
 * A thread line that starts a message, as `src/slack/handlers.ts` writes it:
 * a mention token (with the swarm's annotation, if any), `[Agent]` or
 * `Unknown`, then `: `.
 */
const THREAD_SPEAKER =
  /^(<@[A-Z0-9]+(?:\|[^>]*)?>(?:\s*\((?:unknown user|that['’]s you)\))?|\[Agent\]|Unknown):\s?/;
/** A hand-written thread line: `- Name: text`. */
const BULLET_SPEAKER = /^-\s+([^:\n<>]{1,60}):\s?/;
/** A header line such as "Thread in #swarm-dev (3 earlier messages)". */
const THREAD_HEADER = /\(\d+ earlier messages?\)$/i;

/** Display name for a speaker token. `undefined` when the author is not resolved. */
function speakerName(token: string): string | undefined {
  if (token === "[Agent]" || /\(that['’]s you\)/.test(token)) return "Agent";
  if (token === "Unknown") return undefined;
  if (token.startsWith("<@")) return /^<@[A-Z0-9]+\|([^>]+)>/.exec(token)?.[1]?.trim();
  // A plain name from a `- Name: ` bullet.
  return token.trim();
}

function parseThread(block: string): SlackThreadMessage[] {
  const lines = block.split("\n");
  // Use one line format per block. A Slack-written block starts each message
  // with a mention token, and a list item inside a message body ("- step: do
  // X") must stay part of that message. Only a block with no mention-token
  // lines is read as `- Name: ` bullets.
  const speakerPattern = lines.some((line) => THREAD_SPEAKER.test(line))
    ? THREAD_SPEAKER
    : BULLET_SPEAKER;
  const messages: SlackThreadMessage[] = [];
  for (const line of lines) {
    const token = speakerPattern.exec(line);
    if (token?.[1]) {
      messages.push({ speaker: speakerName(token[1]), text: line.slice(token[0].length) });
      continue;
    }
    const last = messages.at(-1);
    if (last) {
      // A message body can span lines.
      last.text = `${last.text}\n${line}`;
    } else if (line.trim() && !THREAD_HEADER.test(line.trim())) {
      messages.push({ text: line });
    }
  }
  return messages.map((m) => ({ ...m, text: m.text.trim() })).filter((m) => m.text);
}

/**
 * Split a Slack-sourced prompt into the ask, its speaker, and the earlier
 * thread messages. The `<thread_context>` block can come before the message
 * (what the Slack handlers write) or after it. A prompt with no Slack shape
 * comes back as `{ ask: text.trim(), thread: [] }`.
 */
export function parseSlackPrompt(text: string): SlackPrompt {
  const thread: SlackThreadMessage[] = [];
  const outside = text.replace(THREAD_CONTEXT, (_match, block: string) => {
    thread.push(...parseThread(block));
    return "\n\n";
  });
  // Removing the block can leave a run of blank lines where it was.
  let ask = (outside === text ? text : outside.replace(/\n{3,}/g, "\n\n")).trim();
  let speaker: string | undefined;
  const prefix = ASK_SPEAKER.exec(ask);
  if (prefix?.[1]) {
    speaker = speakerName(prefix[1]);
    ask = ask.slice(prefix[0].length).trim();
  }
  return { ask, speaker, thread };
}
