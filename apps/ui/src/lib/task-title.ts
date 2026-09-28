const BARE_TAG = /^<\/?[\w-]+>$/;

/**
 * One-line label for a task in a list row: the explicit title when set,
 * otherwise the first line of the prompt with a leading `Repo: <url>.`
 * preamble removed. Most delegated prompts open with that preamble, so
 * without stripping it every row reads the same. Bare wrapper tag lines
 * (`<thread_context>`) are skipped too.
 */
export function taskListTitle(task: { task: string; title?: string }): string {
  const title = task.title?.trim();
  if (title) return title;
  const text = task.task.trim();
  const stripped = text.replace(/^repo:\s*\S+?[.,;]?(\s+|$)/i, "").trim();
  // Skip bare wrapper tags such as `<thread_context>` that some prompts open with.
  const firstLine =
    (stripped || text).split("\n").find((line) => line.trim() && !BARE_TAG.test(line.trim())) ??
    text;
  return firstLine.trim();
}
