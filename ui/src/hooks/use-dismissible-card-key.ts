/**
 * Phase 4: Pure helper for `use-dismissible-card`.
 *
 * Extracted into its own module so the server-side `bun test` runner can
 * import it without dragging in React, `useConfig`, or the `@/lib/config`
 * alias chain. Lives in `hooks/` next to the consuming hook for proximity.
 */

const NAMESPACE_PREFIX = "swarm:v1";

export function deriveStorageKey(apiUrl: string, cardKey: string): string {
  return `${NAMESPACE_PREFIX}:${apiUrl}:${cardKey}`;
}
