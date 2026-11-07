import { parsePromptDisplay, promptTitle } from "./prompt-display";

/** A plain lowercase first word ("what", "fix"), not a URL, a path or an identifier. */
const PLAIN_FIRST_WORD = /^[a-z][a-z'’-]*[,.:;!?]?(\s|$)/;

/** A markdown heading mark at the start of a line: "## ". */
const HEADING_MARK = /^#{1,6}\s+/;
/** Bold that wraps the whole line: "**Daily report**". */
const WRAPPING_BOLD = /^(\*\*|__)(\S(?:.*\S)?)\1$/;

/**
 * One-line label for a task in a list row: the explicit title when set,
 * otherwise `promptTitle` of the prompt (the ask without wrapper blocks,
 * Slack tokens or a `Repo: <url>.` preamble), with a plain lowercase first
 * word capitalized and a heading mark or a wrapping bold taken off.
 */
export function taskListTitle(task: { task: string; title?: string }): string {
  const title = task.title?.trim();
  if (title) return title;
  const line = promptTitle(task.task);
  // Capitalize first: a heading's first word is often an identifier ("## pr-ci-loop").
  const capitalized = PLAIN_FIRST_WORD.test(line)
    ? line.charAt(0).toUpperCase() + line.slice(1)
    : line;
  return capitalized.replace(HEADING_MARK, "").replace(WRAPPING_BOLD, "$2") || capitalized;
}

/**
 * The prompt to show under a task's title: the ask with Slack tokens read as
 * names and no wrapper blocks. A list preview can stop inside the thread
 * context, before the ask: then the thread messages stand in for it. When
 * the title comes from the prompt, the line it shows (and anything before
 * it, such as a `Repo:` preamble) comes off. Markdown and line breaks stay.
 * Empty when the title is the whole prompt.
 */
export function taskPromptPreview(task: { task: string; title?: string }): string {
  const display = parsePromptDisplay(task.task);
  const thread = display.sections.find((s) => s.tag === "thread_context")?.messages ?? [];
  const body =
    display.ask ||
    thread
      // The title names the first speaker. Later messages keep theirs.
      .map((m, i) => (i > 0 && m.speaker ? `${m.speaker}: ${m.text}` : m.text))
      .join("\n\n");
  if (task.title?.trim()) return body;
  const lines = body.split("\n");
  const titleAt = lines.findIndex((line) => {
    const text = line.trim();
    return text !== "" && (text.includes(display.title) || display.title.endsWith(text));
  });
  return titleAt === -1
    ? body
    : lines
        .slice(titleAt + 1)
        .join("\n")
        .trim();
}
