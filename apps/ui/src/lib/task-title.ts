import { formatSlackMentions, parseSlackPrompt } from "./slack-text";

const BARE_TAG = /^<\/?[\w-]+>$/;
/** A plain lowercase first word ("what", "fix"), not a URL, a path or an identifier. */
const PLAIN_FIRST_WORD = /^[a-z][a-z'’-]*[,.:;!?]?(\s|$)/;

/**
 * One-line label for a task in a list row: the explicit title when set,
 * otherwise the first line of the prompt, made readable:
 * - A Slack prompt loses its `<thread_context>` block and its asker prefix,
 *   and its mention tokens read as names (`@Taras`, never `<@U…|Taras>`).
 * - A leading `Repo: <url>.` preamble is removed. Most delegated prompts open
 *   with it, so without stripping it every row reads the same.
 * - Bare wrapper tag lines (`<thread_context>`) are skipped.
 * - A plain lowercase first word is capitalized.
 */
export function taskListTitle(task: { task: string; title?: string }): string {
  const title = task.title?.trim();
  if (title) return title;
  const text = task.task.trim();
  const ask = formatSlackMentions(parseSlackPrompt(text).ask).trim();
  // A prompt that is only a thread block has no ask: read the whole prompt.
  const source = ask || formatSlackMentions(text).trim() || text;
  const stripped = source.replace(/^repo:\s*\S+?[.,;]?(\s+|$)/i, "").trim();
  // Skip bare wrapper tags such as `<thread_context>` that some prompts open with.
  const firstLine = (
    (stripped || source).split("\n").find((line) => line.trim() && !BARE_TAG.test(line.trim())) ??
    source
  ).trim();
  return PLAIN_FIRST_WORD.test(firstLine)
    ? firstLine.charAt(0).toUpperCase() + firstLine.slice(1)
    : firstLine;
}
