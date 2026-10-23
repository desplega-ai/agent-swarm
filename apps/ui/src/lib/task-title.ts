import { promptTitle } from "./prompt-display";

/** A plain lowercase first word ("what", "fix"), not a URL, a path or an identifier. */
const PLAIN_FIRST_WORD = /^[a-z][a-z'’-]*[,.:;!?]?(\s|$)/;

/**
 * One-line label for a task in a list row: the explicit title when set,
 * otherwise `promptTitle` of the prompt (the ask without wrapper blocks,
 * Slack tokens or a `Repo: <url>.` preamble), with a plain lowercase first
 * word capitalized.
 */
export function taskListTitle(task: { task: string; title?: string }): string {
  const title = task.title?.trim();
  if (title) return title;
  const line = promptTitle(task.task);
  return PLAIN_FIRST_WORD.test(line) ? line.charAt(0).toUpperCase() + line.slice(1) : line;
}
