import { buildClaudeAliasMap } from "./model-alias.ts";
import type { ModelsDevCatalog } from "./types.ts";

/**
 * Moving model aliases.
 *
 * Grammar: `latest:<section>/<target>[@stable|@any]`
 *   latest:anthropic/<family>  → newest undated `claude-*` id of that family
 *                                 (the same rule as buildClaudeAliasMap).
 *   latest:openrouter/<vendor>/<glob>
 *                              → newest id in the `openrouter` section matching
 *                                 the glob (`*` = any run of characters) under
 *                                 the literal `<vendor>/` namespace,
 *                                 returned with the `openrouter/` prefix pi and
 *                                 opencode expect in MODEL_OVERRIDE.
 *   latest:openai/<glob>       → newest id in the `openai` section matching the
 *                                 glob, returned WITHOUT a prefix.
 *
 * Glob candidates skip `-latest`, dated (-YYYYMMDD), `:free` and preview ids
 * unless the glob itself names them. Newest = max `release_date`, ties broken
 * by the lexicographically greatest id, so the result is deterministic for a
 * given catalog.
 *
 * Channel (default `@stable`): `@stable` also drops ids containing
 * `preview`/`experimental` (unless the target names them) and models released
 * fewer than `policy.soakDays` days before `policy.now`. With no policy the
 * soak is 0, so an alias without a channel resolves exactly as before the
 * channel existed. `@any` disables the preview/experimental and soak filters.
 * `policy.isSupported` drops ids a caller cannot run, on every channel.
 *
 * Pure: no IO, no Bun APIs. Callers pass the catalog.
 */

const LATEST_PREFIX = "latest:";
const DATED_ID_RE = /-\d{8}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AliasChannel = "stable" | "any";

export type ParsedAlias =
  | { kind: "anthropic"; family: string; channel: AliasChannel }
  | { kind: "openrouter"; glob: string; channel: AliasChannel }
  | { kind: "openai"; glob: string; channel: AliasChannel };

export interface AliasPolicy {
  /** Minimum model age in days on the `@stable` channel. Default 0. */
  soakDays?: number;
  /** Reference time for the soak window. Default `new Date()`. */
  now?: Date;
  /** Candidate filter (e.g. ids a CLI can run). Receives the bare section id. */
  isSupported?: (id: string) => boolean;
}

/** True when the value uses the moving-alias grammar prefix. */
export function isAlias(value: string): boolean {
  return value.trim().toLowerCase().startsWith(LATEST_PREFIX);
}

const GLOB_TARGET_RE = /^[a-z0-9._:~*/-]+$/;
/**
 * An openrouter glob names its vendor literally (`deepseek/…`), so a catalog id can only match
 * inside the vendor namespace the operator chose, never another vendor's.
 */
const OPENROUTER_VENDOR_RE = /^[a-z0-9._~-]+\//;

/** Parse an alias string; null when it is not valid grammar. */
export function parseAlias(alias: string): ParsedAlias | null {
  let value = alias.trim().toLowerCase();
  if (!value.startsWith(LATEST_PREFIX)) return null;
  let channel: AliasChannel = "stable";
  const at = value.lastIndexOf("@");
  if (at >= 0) {
    const suffix = value.slice(at + 1);
    if (suffix !== "stable" && suffix !== "any") return null;
    channel = suffix;
    value = value.slice(0, at);
  }
  const rest = value.slice(LATEST_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const section = rest.slice(0, slash);
  const target = rest.slice(slash + 1);
  if (target.length === 0) return null;
  if (section === "anthropic") {
    return /^[a-z]+$/.test(target) ? { kind: "anthropic", family: target, channel } : null;
  }
  if (section === "openrouter" && !OPENROUTER_VENDOR_RE.test(target)) return null;
  if (section === "openrouter" || section === "openai") {
    return GLOB_TARGET_RE.test(target) ? { kind: section, glob: target, channel } : null;
  }
  return null;
}

/** Glob → anchored RegExp; `*` matches any run of characters. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Strict ordering: release_date first, then id (lexicographic). */
export function isNewer(
  a: { id: string; releaseDate: string },
  b: { id: string; releaseDate: string },
): boolean {
  if (a.releaseDate !== b.releaseDate) return a.releaseDate > b.releaseDate;
  return a.id > b.id;
}

/** Channel/policy filter shared by every section. `named` = what the target spells out. */
function passesPolicy(
  id: string,
  releaseDate: string | undefined,
  channel: AliasChannel,
  named: string,
  policy: AliasPolicy,
): boolean {
  if (policy.isSupported && !policy.isSupported(id)) return false;
  if (channel === "any") return true;
  const lower = id.toLowerCase();
  if (!named.includes("preview") && lower.includes("preview")) return false;
  if (!named.includes("experimental") && lower.includes("experimental")) return false;
  const soakDays = policy.soakDays ?? 0;
  if (soakDays > 0 && releaseDate) {
    const released = Date.parse(releaseDate);
    const now = (policy.now ?? new Date()).getTime();
    if (!Number.isNaN(released) && now - released < soakDays * DAY_MS) return false;
  }
  return true;
}

/** Resolve an alias to a concrete MODEL_OVERRIDE id; null when nothing matches. */
export function resolveAlias(
  alias: string,
  catalog: ModelsDevCatalog,
  policy: AliasPolicy = {},
): string | null {
  const parsed = parseAlias(alias);
  if (!parsed) return null;
  if (parsed.kind === "anthropic") {
    const models = catalog.anthropic?.models ?? {};
    const map = buildClaudeAliasMap(
      Object.entries(models)
        .filter(([id, m]) => passesPolicy(id, m.release_date, parsed.channel, "", policy))
        .map(([id, m]) => ({ id, releaseDate: m.release_date ?? null })),
    );
    return map[parsed.family] ?? null;
  }
  const re = globToRegExp(parsed.glob);
  const allowFree = parsed.glob.includes(":free");
  const allowLatest = parsed.glob.includes("latest");
  const allowPreview = parsed.glob.includes("preview");
  let best: { id: string; releaseDate: string } | null = null;
  for (const [id, m] of Object.entries(catalog[parsed.kind]?.models ?? {})) {
    const lower = id.toLowerCase();
    if (!re.test(lower)) continue;
    if (DATED_ID_RE.test(lower)) continue;
    if (!allowLatest && lower.endsWith("-latest")) continue;
    if (!allowFree && lower.endsWith(":free")) continue;
    if (parsed.channel === "stable" && !allowPreview && lower.includes("preview")) continue;
    if (!passesPolicy(id, m.release_date, parsed.channel, parsed.glob, policy)) continue;
    const candidate = { id, releaseDate: m.release_date ?? "" };
    if (!best || isNewer(candidate, best)) best = candidate;
  }
  if (!best) return null;
  return parsed.kind === "openrouter" ? `openrouter/${best.id}` : best.id;
}
