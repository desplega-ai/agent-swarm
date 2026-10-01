/**
 * Logical memory paths. A memory's `key` column may hold a path such as
 * `/longterm/entities/people/taras` instead of the auto key
 * `<scope>/manual/<id>`. The curated tree lives under `/longterm`; a memory
 * with any other key (auto keys, file-index paths under `/workspace/...`) is
 * inbox material. Paths start with `/` and a root segment, so they never
 * collide with file-index keys or auto keys.
 */

export const LONGTERM_ROOT = "/longterm";

/** Shape of a key written through `memory-store` or `memory-edit` `newKey`. */
export const MEMORY_KEY_PATTERN = /^\/[a-z0-9-]+(\/[a-z0-9._-]+)*$/;

export const MEMORY_KEY_PATTERN_MESSAGE =
  "Key must be a path like /longterm/facts/swarm-runtime/slug: start with '/', a lowercase root segment, then segments of lowercase letters, digits, '.', '_' or '-', no trailing '/'.";

export const MEMORY_KEY_MAX_LENGTH = 200;

/** Roots only the lead may write: lane-maintained, consolidated paths. */
const LEAD_ONLY_KEY_ROOTS: readonly string[] = [
  `${LONGTERM_ROOT}/company-story`,
  `${LONGTERM_ROOT}/entities`,
  `${LONGTERM_ROOT}/timeline`,
];

/** True when `key` is `root` itself or sits beneath it (`/longterm/entities-x` is not under `/longterm/entities`). */
export function isKeyUnderRoot(key: string, root: string): boolean {
  return key === root || key.startsWith(`${root}/`);
}

export function isLeadOnlyKey(key: string): boolean {
  return LEAD_ONLY_KEY_ROOTS.some((root) => isKeyUnderRoot(key, root));
}

/** Refusal text for a non-lead write to a lead-only path, or null when the write is allowed. */
export function leadOnlyKeyViolation(key: string, isLead: boolean): string | null {
  if (isLead || !isLeadOnlyKey(key)) return null;
  return `Key "${key}" is under a lead-only path (${LEAD_ONLY_KEY_ROOTS.join(", ")}). Write under ${LONGTERM_ROOT}/facts or leave the key off; the lead consolidates the rest.`;
}

/**
 * The key a `memory-store` call writes: an explicit `key`, else the `name`
 * when it is itself a `/longterm/` path, so an agent sets one field. Null when
 * neither applies and the memory gets its auto key.
 */
export function resolveStoreKey(key: string | undefined, name: string | undefined): string | null {
  if (key) return key;
  return name?.startsWith(`${LONGTERM_ROOT}/`) ? name : null;
}
