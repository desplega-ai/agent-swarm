/** Unset enables citation ratings and self-rating hints; an explicitly empty value disables all raters. */
export function getMemoryRaterNames(): string[] {
  return (process.env.MEMORY_RATERS ?? "implicit-citation,explicit-self")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}
