import { formatSlackMentions, parseSlackPrompt } from "./slack-text";

/**
 * A raw task prompt as people read it. The backend wraps context in tag
 * blocks before the ask: `<thread_context>` (Slack and Chat SDK threads),
 * `<sibling_tasks_in_progress>` (`src/tasks/sibling-block.ts`),
 * `<page_feedback>` (page feedback tasks) and `<system_instructions>` (a
 * cursor session's first message). It also adds markers around the text: a
 * `[Thread follow-up — N message(s) buffered]` prefix (`src/slack/thread-buffer.ts`,
 * `src/integrations/chat-sdk/inbound.ts`), and, in the prompt a harness
 * receives, a `[steering <id>] From <sender>:` envelope with its accept-steer
 * reminder, a `Requested by:` line and a `When done, use store-progress` line
 * (`src/commands/runner.ts`, `src/prompts/session-templates.ts`). Display
 * only: the stored text never changes.
 */

/** A marker taken off the prompt, shown as a small label and value. */
export interface PromptMeta {
  label: string;
  value: string;
}

/** A wrapper block pulled out of the prompt. */
export interface PromptSection {
  /** The wrapper tag, such as `thread_context`. */
  tag: string;
  /** What the section shows as its heading. */
  label: string;
  /** Earlier thread messages, for `thread_context`. Mentions read as names. */
  messages?: { speaker?: string; text: string }[];
  /** The block body, for every other tag. Mentions read as names. */
  text?: string;
  /** Open by default, because the block holds the substance of the ask. */
  defaultOpen?: boolean;
}

export interface PromptDisplay {
  /** One line for a title or a list row. */
  title: string;
  /** Who asked, from a leading `<@ID|Name>: ` prefix. */
  speaker?: string;
  /** The ask without the wrapper blocks. Mentions read as names. */
  ask: string;
  /** Wrapper blocks, in the order to show them above the ask. */
  sections: PromptSection[];
  /** Markers taken off the start or end of the prompt, in prompt order. */
  meta: PromptMeta[];
}

const KNOWN_TAGS: Record<string, { label: string; defaultOpen?: boolean }> = {
  thread_context: { label: "Thread context" },
  sibling_tasks_in_progress: { label: "Tasks already running in this thread" },
  page_feedback: { label: "Page feedback", defaultOpen: true },
  system_instructions: { label: "System instructions" },
};

/**
 * A wrapper block: an opening tag alone on its line, a closing tag alone on
 * its line. The name needs a `_` or `-`, so inline HTML such as `<div>` stays
 * text. `thread_context` is left to `parseSlackPrompt`.
 */
const WRAPPER_BLOCK =
  /^[ \t]*<([a-z][a-z0-9]*[_-][a-z0-9_-]*)>[ \t]*\n([\s\S]*?)\n[ \t]*<\/\1>[ \t]*$/gm;
const WRAPPER_OPEN = /^[ \t]*<([a-z][a-z0-9]*[_-][a-z0-9_-]*)>[ \t]*$/gm;
/** A Slack token or wrapper tag cut by the list preview's `…`, such as `<#C0OPS…`. */
const CUT_TOKEN = /<(?:[@#!]|\/?[a-z][a-z0-9]*[_-]|https?:|mailto:)[^<>\n]*…$/;

/**
 * List rows carry a ~300-character preview of the prompt that ends in `…`
 * (`src/be/db/tasks/read.ts`). The cut can land inside a Slack token or a
 * wrapper block: drop the cut token and close the open block.
 */
function repairPreview(text: string): string {
  let repaired = text.replace(CUT_TOKEN, "…");
  for (const open of [...repaired.matchAll(WRAPPER_OPEN)]) {
    const close = `</${open[1]}>`;
    if (!repaired.includes(close, (open.index ?? 0) + open[0].length)) {
      repaired = `${repaired}\n${close}`;
    }
  }
  return repaired;
}

/** `[Thread follow-up — 3 message(s) buffered]` (Slack) or `[Thread follow-up: 3 …]` (Chat SDK). */
const FOLLOW_UP = /^\s*\[Thread follow-up(?: —|:) (\d+) message\(s\) buffered\]\s*/;
/** The steering envelope from the `system.agent.steering.delivery` template. */
const STEERING = /^\s*\[steering ([^\]\s]+)\] From ([^:\n]+):[ \t]?/;
const STEERING_REMINDER = /\n*\(Once you have acted on this, call `accept-steer`[^\n]*\)\s*$/;
const REQUESTED_BY = /\n+Requested by: ([^\n]+)\s*$/;
const OUTPUT_REMINDER = /\n+When done, use `store-progress` with status: "completed"[^\n]*\s*$/;

/** Take the markers off the start and end of a prompt. */
function takeMarkers(raw: string): { text: string; meta: PromptMeta[] } {
  const head: PromptMeta[] = [];
  const tail: PromptMeta[] = [];
  let text = raw;
  const followUp = FOLLOW_UP.exec(text);
  if (followUp) {
    head.push({ label: "Thread follow-up", value: `${followUp[1]} buffered message(s)` });
    text = text.slice(followUp[0].length);
  }
  const steering = STEERING.exec(text);
  if (steering?.[1] && steering[2]) {
    head.push({ label: "Steering", value: `${steering[2].trim()} (${steering[1]})` });
    text = text.slice(steering[0].length).replace(STEERING_REMINDER, "");
  }
  // The harness prompt ends with the requester, then the output reminder.
  for (;;) {
    const output = OUTPUT_REMINDER.exec(text);
    if (output) {
      tail.unshift({ label: "Output", value: "store-progress when done" });
      text = text.slice(0, output.index);
      continue;
    }
    const requestedBy = REQUESTED_BY.exec(text);
    if (requestedBy?.[1]) {
      tail.unshift({ label: "Requested by", value: requestedBy[1].trim() });
      text = text.slice(0, requestedBy.index);
      continue;
    }
    break;
  }
  return { text, meta: [...head, ...tail] };
}

const BARE_TAG = /^<\/?[\w-]+>$/;

function tagLabel(tag: string): string {
  const known = KNOWN_TAGS[tag]?.label;
  if (known) return known;
  const words = tag.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One line from a prompt: the first line of the ask, without a leading
 * `Repo: <url>.` preamble or bare tag lines.
 */
function titleLine(ask: string, raw: string): string {
  // A prompt that is only wrapper blocks has no ask: read the whole prompt.
  const source = ask || formatSlackMentions(raw).trim() || raw.trim();
  const stripped = source.replace(/^repo:\s*\S+?[.,;]?(\s+|$)/i, "").trim();
  return (
    (stripped || source).split("\n").find((line) => line.trim() && !BARE_TAG.test(line.trim())) ??
    source
  ).trim();
}

/**
 * Split a raw task prompt into a one-line title, the ask, and its wrapper
 * blocks. Thread context comes first, then the other blocks in prompt order.
 * An unknown `<some_tag>` block becomes a section labelled "Some tag".
 * Markers move to `meta`. A list preview cut inside a token or a block is
 * repaired first. A prompt with no tokens comes back as its trimmed text with
 * no sections and no meta.
 */
export function parsePromptDisplay(input: string): PromptDisplay {
  const raw = repairPreview(input);
  const others: PromptSection[] = [];
  const rest = raw.replace(WRAPPER_BLOCK, (match, tag: string, body: string) => {
    if (tag === "thread_context") return match;
    others.push({
      tag,
      label: tagLabel(tag),
      text: formatSlackMentions(body).trim(),
      ...(KNOWN_TAGS[tag]?.defaultOpen ? { defaultOpen: true } : {}),
    });
    return "\n\n";
  });
  // A sibling block goes before the rest of the prompt, so markers come after it.
  const { text, meta } = takeMarkers(rest === raw ? raw : rest.replace(/\n{3,}/g, "\n\n"));
  const slack = parseSlackPrompt(text);
  const sections: PromptSection[] = [];
  if (slack.thread.length > 0) {
    sections.push({
      tag: "thread_context",
      label: tagLabel("thread_context"),
      messages: slack.thread.map((m) => ({
        speaker: m.speaker,
        text: formatSlackMentions(m.text).trim(),
      })),
    });
  }
  sections.push(...others);
  const ask = formatSlackMentions(slack.ask).trim();
  return {
    title: titleLine(ask, text.trim() ? text : raw),
    speaker: slack.speaker,
    ask,
    sections,
    meta,
  };
}

/** One-line title for a raw task prompt. */
export function promptTitle(raw: string): string {
  return parsePromptDisplay(raw).title;
}
