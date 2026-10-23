import { formatSlackMentions, parseSlackPrompt } from "./slack-text";

/**
 * A raw task prompt as people read it. The backend wraps context in tag
 * blocks before the ask: `<thread_context>` (Slack and Chat SDK threads),
 * `<sibling_tasks_in_progress>` (`src/tasks/sibling-block.ts`),
 * `<page_feedback>` (page feedback tasks) and `<system_instructions>` (a
 * cursor session's first message). It also adds markers around the text: a
 * `[chat] <facts>` header line (`src/integrations/chat-sdk/templates.ts`), a
 * `[Thread follow-up — N message(s) buffered]` prefix (`src/slack/thread-buffer.ts`,
 * `src/integrations/chat-sdk/inbound.ts`), an `[App action] …` /
 * `Caller (server-verified): …` suffix (the `task.app.action` template), and,
 * in the prompt a harness receives, a `[steering <id>] From <sender>:`
 * envelope with its accept-steer reminder, a `Requested by:` line and a
 * `When done, use store-progress` line (`src/commands/runner.ts`,
 * `src/prompts/session-templates.ts`). Only those generated shapes come off:
 * other tags and fenced code stay in the ask. Display only: the stored text
 * never changes.
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

const WRAPPER_TAGS = Object.keys(KNOWN_TAGS).join("|");
/**
 * A generated wrapper block: a known opening tag alone on its line, its
 * closing tag alone on its line. `thread_context` is left to `parseSlackPrompt`.
 */
const WRAPPER_BLOCK = new RegExp(
  `^[ \\t]*<(${WRAPPER_TAGS})>[ \\t]*\\n([\\s\\S]*?)\\n[ \\t]*<\\/\\1>[ \\t]*$`,
  "gm",
);
const WRAPPER_OPEN = new RegExp(`^[ \\t]*<(${WRAPPER_TAGS})>[ \\t]*$`, "gm");
/** A Slack token or wrapper tag cut by the list preview's `…`, such as `<#C0OPS…`. */
const CUT_TOKEN = /<(?:[@#!]|\/?[a-z][a-z0-9]*[_-]|https?:|mailto:)[^<>\n]*…$/;

/**
 * List rows carry the first `TASK_PREVIEW_LENGTH` UTF-16 units of the prompt
 * plus `…` (`previewText` in `src/be/db.ts`, used by `src/be/db/tasks/read.ts`).
 */
const TASK_PREVIEW_LENGTH = 300;

function isListPreview(text: string): boolean {
  return text.length === TASK_PREVIEW_LENGTH + 1 && text.endsWith("…");
}

/**
 * The preview cut can land inside a Slack token or a generated block: drop
 * the cut token and close the open block. Only for a list preview: a full
 * prompt with an unclosed tag is literal text.
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

/**
 * A fenced code block, or an opening fence with no close (a cut preview) to
 * the end. Its text is code: no tag inside it is a wrapper.
 */
const FENCE = /^[ \t]*(`{3,}|~{3,})[^\n]*(?:(?:\n[\s\S]*?)?\n[ \t]*\1[ \t]*(?=\n|$)|[\s\S]*$)/gm;
const FENCE_SLOT = /\uE000(\d+)\uE001/g;

/** Swap fenced code for placeholders that no parser below matches. */
function holdFences(text: string): { text: string; restore: (s: string) => string } {
  const fences: string[] = [];
  const held = text.replace(FENCE, (fence) => `\uE000${fences.push(fence) - 1}\uE001`);
  if (fences.length === 0) return { text, restore: (s) => s };
  return {
    text: held,
    restore: (s) => s.replace(FENCE_SLOT, (_m, i: string) => fences[Number(i)] ?? ""),
  };
}

/**
 * The Chat SDK header line, `[chat] <facts>` (`formatChatHeaderFacts` in
 * `src/integrations/chat-sdk/facts.ts`): adapter and chat, then `from:`,
 * `addressed:` and an optional quoted `reply-to:`, joined with ` · `.
 */
const CHAT_HEADER = /^\s*\[chat\] ([^\n]*)\n*/;
const CHAT_FACTS = /^(.*?) · from: (.*) · addressed: ([a-z-]+)(?: · reply-to: "(.*)")?$/;
/** `[Thread follow-up — 3 message(s) buffered]` (Slack) or `[Thread follow-up: 3 …]` (Chat SDK). */
const FOLLOW_UP = /^\s*\[Thread follow-up(?: —|:) (\d+) message\(s\) buffered\]\s*/;
/** The steering envelope from the `system.agent.steering.delivery` template. */
const STEERING = /^\s*\[steering ([^\]\s]+)\] From ([^:\n]+):[ \t]?/;
const STEERING_REMINDER = /\n*\(Once you have acted on this, call `accept-steer`[^\n]*\)\s*$/;
const REQUESTED_BY = /\n+Requested by: ([^\n]+)\s*$/;
const OUTPUT_REMINDER = /\n+When done, use `store-progress` with status: "completed"[^\n]*\s*$/;
/** The `task.app.action` suffix. Both JSON values are `JSON.stringify` output: one line each. */
const APP_ACTION =
  /(?:^|\n+)\[App action\] app=(\S+) action=(\S+) input=([^\n]*)\nCaller \(server-verified\): ([^\n]*)\s*$/;

function chatMeta(facts: string): { meta: PromptMeta[]; speaker?: string } {
  const parts = CHAT_FACTS.exec(facts);
  if (!parts?.[1] || !parts[2] || !parts[3]) return { meta: [{ label: "Chat", value: facts }] };
  const meta = [
    { label: "Chat", value: parts[1] },
    { label: "Addressed", value: parts[3] },
  ];
  if (parts[4]) meta.push({ label: "Reply to", value: parts[4] });
  return { meta, speaker: parts[2] };
}

/** An `AppActionCaller` (`src/apps/action-caller.ts`) as one line. */
function callerLabel(json: string): string {
  try {
    const caller = JSON.parse(json) as { kind?: unknown; id?: unknown; name?: unknown };
    const kind = typeof caller.kind === "string" ? caller.kind : "";
    if (typeof caller.name === "string" && caller.name) {
      return kind ? `${caller.name} (${kind})` : caller.name;
    }
    if (typeof caller.id === "string" && caller.id)
      return kind ? `${kind} ${caller.id}` : caller.id;
    return kind || json;
  } catch {
    return json;
  }
}

function takeFollowUp(text: string): { text: string; meta?: PromptMeta } {
  const followUp = FOLLOW_UP.exec(text);
  if (!followUp) return { text };
  return {
    text: text.slice(followUp[0].length),
    meta: { label: "Thread follow-up", value: `${followUp[1]} buffered message(s)` },
  };
}

/** Take the markers off the start and end of a prompt. */
function takeMarkers(raw: string): {
  text: string;
  head: PromptMeta[];
  tail: PromptMeta[];
  speaker?: string;
} {
  const head: PromptMeta[] = [];
  const tail: PromptMeta[] = [];
  let text = raw;
  let speaker: string | undefined;
  const chat = CHAT_HEADER.exec(text);
  if (chat?.[1]) {
    const facts = chatMeta(chat[1].trim());
    head.push(...facts.meta);
    speaker = facts.speaker;
    text = text.slice(chat[0].length);
  }
  const followUp = takeFollowUp(text);
  if (followUp.meta) head.push(followUp.meta);
  text = followUp.text;
  const steering = STEERING.exec(text);
  if (steering?.[1] && steering[2]) {
    head.push({ label: "Steering", value: `${steering[2].trim()} (${steering[1]})` });
    text = text.slice(steering[0].length).replace(STEERING_REMINDER, "");
  }
  // The harness prompt ends with the requester, then the output reminder. An
  // app action's suffix comes before both.
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
    const app = APP_ACTION.exec(text);
    if (app?.[1] && app[2] && app[3] !== undefined && app[4] !== undefined) {
      tail.unshift(
        { label: "App action", value: `${app[2]} on ${app[1]}` },
        ...(app[3] && app[3] !== "{}" ? [{ label: "Input", value: app[3] }] : []),
        { label: "Caller", value: callerLabel(app[4]) },
      );
      text = text.slice(0, app.index);
      continue;
    }
    break;
  }
  return { text, head, tail, speaker };
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
 * Only the generated blocks and markers listed at the top of this file come
 * off; any other tag, and anything inside fenced code, stays in the ask. A
 * list preview cut inside a token or a block is repaired first. A prompt with
 * no generated shapes comes back as its trimmed text with no sections and no
 * meta.
 */
export function parsePromptDisplay(input: string): PromptDisplay {
  const fences = holdFences(input);
  const raw = isListPreview(input) ? repairPreview(fences.text) : fences.text;
  const others: PromptSection[] = [];
  const rest = raw.replace(WRAPPER_BLOCK, (match, tag: string, body: string) => {
    if (tag === "thread_context") return match;
    others.push({
      tag,
      label: tagLabel(tag),
      text: fences.restore(formatSlackMentions(body).trim()),
      ...(KNOWN_TAGS[tag]?.defaultOpen ? { defaultOpen: true } : {}),
    });
    return "\n\n";
  });
  // A sibling block goes before the rest of the prompt, so markers come after it.
  const marked = takeMarkers(rest === raw ? raw : rest.replace(/\n{3,}/g, "\n\n"));
  const { text } = marked;
  const slack = parseSlackPrompt(text);
  const sections: PromptSection[] = [];
  if (slack.thread.length > 0) {
    sections.push({
      tag: "thread_context",
      label: tagLabel("thread_context"),
      messages: slack.thread.map((m) => ({
        speaker: m.speaker,
        text: fences.restore(formatSlackMentions(m.text).trim()),
      })),
    });
  }
  sections.push(...others);
  // A Chat SDK prompt puts its follow-up marker after the thread block.
  const followUp = slack.thread.length > 0 ? takeFollowUp(slack.ask) : { text: slack.ask };
  const meta = [...marked.head, ...(followUp.meta ? [followUp.meta] : []), ...marked.tail];
  const ask = fences.restore(formatSlackMentions(followUp.text).trim());
  return {
    title: titleLine(ask, fences.restore(text.trim() ? text : raw)),
    speaker: slack.speaker ?? marked.speaker,
    ask,
    sections,
    meta,
  };
}

/** One-line title for a raw task prompt. */
export function promptTitle(raw: string): string {
  return parsePromptDisplay(raw).title;
}
