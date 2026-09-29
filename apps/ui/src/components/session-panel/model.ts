/**
 * Session panel — pure helpers for context keys, the page-context footer, and
 * dropdown labels. No React, no fetch.
 *
 * Keys: the host picks a stable `pageKey` (`task:ui:{kind}:{ref}` in the
 * dashboard). Each session gets `contextKey = {pageKey}:{nonce}`, and the
 * dropdown lists sessions with `contextKeyPrefix = {pageKey}:`. The key is per
 * session on purpose: a page-level key would let server-side sibling awareness
 * nest a new session under one already running on the same page.
 */

/** Prefix that matches every session under `pageKey`, and nothing under a longer key. */
export function contextKeyPrefix(pageKey: string): string {
  return `${pageKey}:`;
}

/** A new, per-session context key: exactly one extra part under the page key. */
export function newSessionContextKey(pageKey: string): string {
  return `${pageKey}:${crypto.randomUUID()}`;
}

const FOOTER_HEADING = "Page context";
const FOOTER_PATTERN = new RegExp(`\\n*---\\n${FOOTER_HEADING}(?: \\([^)\\n]*\\))?\\n[\\s\\S]*$`);

/**
 * Footer appended to the root task text only (follow-ups reach the lead
 * through the parent-chain preamble). It goes last so session titles and
 * previews still start with what the user typed.
 */
export function buildContextFooter(
  fields: ReadonlyArray<readonly [label: string, value: string | undefined]>,
  surface?: string,
): string {
  const lines = ["---", surface ? `${FOOTER_HEADING} (${surface})` : FOOTER_HEADING];
  for (const [label, value] of fields) {
    if (value) lines.push(`- ${label}: ${value}`);
  }
  return lines.join("\n");
}

export function withContextFooter(text: string, footer: string | undefined): string {
  return footer ? `${text}\n\n${footer}` : text;
}

/** The user's own words, without the footer the panel appended. */
export function stripContextFooter(text: string): string {
  return text.replace(FOOTER_PATTERN, "").trimEnd();
}

/** Dropdown label: custom title, else the first line of what the user typed. */
export function sessionLabel(
  root: { task: string; title?: string; taskPreview?: string },
  maxLength = 80,
): string {
  const raw = root.title?.trim() || stripContextFooter(root.taskPreview ?? root.task);
  const firstLine =
    raw
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  if (!firstLine) return "Untitled session";
  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength - 1)}…` : firstLine;
}
