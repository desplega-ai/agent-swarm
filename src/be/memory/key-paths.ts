import type { AgentMemorySource } from "@/types";

/**
 * Logical memory paths. A memory's `key` column may hold a path such as
 * `/longterm/entities/people/taras` instead of the auto key
 * `<scope>/manual/<id>`. The curated tree lives under `/longterm`; a memory
 * with any other key (auto keys, file-index paths under `/workspace/...`) is
 * inbox material. Paths start with `/` and a root segment, so they never
 * collide with file-index keys or auto keys.
 *
 * The key is the tier, `source` stays provenance: a memory under `/longterm`
 * gets the lifecycle of a `manual` memory whatever its `source` (see
 * `tierSource`).
 */

export const LONGTERM_ROOT = "/longterm";

/** Shape of a key written through `memory-store` or `memory-edit` `newKey`. */
export const MEMORY_KEY_PATTERN = /^\/[a-z0-9-]+(\/[a-z0-9._-]+)*$/;

export const MEMORY_KEY_PATTERN_MESSAGE =
  "Key must be a path like /longterm/facts/swarm-runtime/slug: start with '/', a lowercase root segment, then segments of lowercase letters, digits, '.', '_' or '-', no trailing '/'.";

export const MEMORY_KEY_MAX_LENGTH = 200;

/** The only second segments a `/longterm` key may have. A closed list: an unknown root would store but never rank. */
export const LONGTERM_ROOTS = [
  "company-story",
  "entities",
  "facts",
  "decisions",
  "workstreams",
  "timeline",
] as const;

/** The only third segments under `/longterm/entities`. Agent profiles and `get-repos` own agents and repos. */
export const LONGTERM_ENTITY_TYPES = ["people", "customers"] as const;

/** Roots only the lead may write: lane-maintained, consolidated paths. */
const CONSOLIDATED_KEY_ROOTS: readonly string[] = [
  `${LONGTERM_ROOT}/company-story`,
  `${LONGTERM_ROOT}/entities`,
  `${LONGTERM_ROOT}/timeline`,
];

/** True when `key` is `root` itself or sits beneath it (`/longterm/entities-x` is not under `/longterm/entities`). */
export function isKeyUnderRoot(key: string, root: string): boolean {
  return key === root || key.startsWith(`${root}/`);
}

/** True when `key` is `/longterm` or sits beneath it: the curated tier. */
export function isLongtermKey(key: string | null | undefined): boolean {
  return !!key && isKeyUnderRoot(key, LONGTERM_ROOT);
}

/**
 * Why a `/longterm` key is refused, or null when it is allowed (or sits outside
 * `/longterm`, where keys stay free-form). Only the first segments are checked;
 * leaf slugs are the caller's, within MEMORY_KEY_PATTERN.
 */
export function longtermKeyError(key: string): string | null {
  if (!isLongtermKey(key)) return null;
  const [root, entityType] = key.split("/").slice(2);
  if (!LONGTERM_ROOTS.some((allowed) => allowed === root)) {
    return `Key "${key}" is not allowed: the segment after ${LONGTERM_ROOT} must be one of ${LONGTERM_ROOTS.join(", ")}, as in ${LONGTERM_ROOT}/facts/<topic>/<slug>.`;
  }
  if (root === "entities" && !LONGTERM_ENTITY_TYPES.some((allowed) => allowed === entityType)) {
    return `Key "${key}" is not allowed: the segment after ${LONGTERM_ROOT}/entities must be one of ${LONGTERM_ENTITY_TYPES.join(", ")}, as in ${LONGTERM_ROOT}/entities/people/<slug>.`;
  }
  return null;
}

/**
 * The source whose lifecycle a memory follows: a memory under `/longterm` is
 * `manual` (no TTL, no recency decay, quality 1.5, protected from cleanup),
 * any other keeps its own. Provenance stays on `source`; the key is the tier.
 */
export function tierSource(
  source: AgentMemorySource,
  key: string | null | undefined,
): AgentMemorySource {
  return isLongtermKey(key) ? "manual" : source;
}

/** True when `key` is under a root that needs the `memory.write.consolidated` permission. */
export function isConsolidatedKey(key: string): boolean {
  return CONSOLIDATED_KEY_ROOTS.some((root) => isKeyUnderRoot(key, root));
}

/** Refusal text for a write to a lead-only path. The allow/deny decision is `can()`'s. */
export function consolidatedKeyMessage(key: string): string {
  return `Key "${key}" is under a lead-only path (${CONSOLIDATED_KEY_ROOTS.join(", ")}). Write under ${LONGTERM_ROOT}/facts or leave the key off; the lead consolidates the rest.`;
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
