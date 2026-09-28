import type { HarnessConfig } from "../types.ts";
import type { ModelsDevCatalog } from "./catalog.ts";
import { buildClaudeAliasMap } from "./model-alias.ts";

/**
 * Moving model aliases for harness configs (`HarnessConfig.modelAlias`).
 *
 * Grammar:
 *   latest:anthropic/<family>  → newest undated `claude-*` id of that family
 *                                 (the same rule as buildClaudeAliasMap).
 *   latest:openrouter/<glob>   → newest id in the `openrouter` section matching
 *                                 the glob (`*` = any run of characters),
 *                                 returned with the `openrouter/` prefix pi and
 *                                 opencode expect in MODEL_OVERRIDE.
 *
 * OpenRouter candidates skip `-latest`, dated (-YYYYMMDD), `:free` and preview
 * ids unless the glob itself names them. Newest = max `release_date`, ties
 * broken by the lexicographically greatest id, so the result is deterministic
 * for a given catalog.
 *
 * Pure: callers pass the catalog (see getResolutionCatalog, which limits IDs
 * to the reviewed snapshot). The runner resolves once per run, at creation.
 */

const LATEST_PREFIX = "latest:";
const DATED_ID_RE = /-\d{8}$/;

export type ParsedAlias =
  | { kind: "anthropic"; family: string }
  | { kind: "openrouter"; glob: string };

/** Parse an alias string; null when it is not valid grammar. */
export function parseAlias(alias: string): ParsedAlias | null {
  const value = alias.trim().toLowerCase();
  if (!value.startsWith(LATEST_PREFIX)) return null;
  const rest = value.slice(LATEST_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const section = rest.slice(0, slash);
  const target = rest.slice(slash + 1);
  if (target.length === 0) return null;
  if (section === "anthropic") {
    return /^[a-z]+$/.test(target) ? { kind: "anthropic", family: target } : null;
  }
  if (section === "openrouter") {
    return /^[a-z0-9._:~*/-]+$/.test(target) ? { kind: "openrouter", glob: target } : null;
  }
  return null;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function isNewer(
  a: { id: string; releaseDate: string },
  b: { id: string; releaseDate: string },
): boolean {
  if (a.releaseDate !== b.releaseDate) return a.releaseDate > b.releaseDate;
  return a.id > b.id;
}

/** Resolve an alias to a concrete MODEL_OVERRIDE id; null when nothing matches. */
export function resolveAlias(alias: string, catalog: ModelsDevCatalog): string | null {
  const parsed = parseAlias(alias);
  if (!parsed) return null;
  if (parsed.kind === "anthropic") {
    const models = catalog.anthropic?.models ?? {};
    const map = buildClaudeAliasMap(
      Object.entries(models).map(([id, m]) => ({ id, releaseDate: m.release_date ?? null })),
    );
    return map[parsed.family] ?? null;
  }
  const re = globToRegExp(parsed.glob);
  const allowFree = parsed.glob.includes(":free");
  const allowLatest = parsed.glob.includes("latest");
  const allowPreview = parsed.glob.includes("preview");
  let best: { id: string; releaseDate: string } | null = null;
  for (const [id, m] of Object.entries(catalog.openrouter?.models ?? {})) {
    const lower = id.toLowerCase();
    if (!re.test(lower)) continue;
    if (DATED_ID_RE.test(lower)) continue;
    if (!allowLatest && lower.endsWith("-latest")) continue;
    if (!allowFree && lower.endsWith(":free")) continue;
    if (!allowPreview && lower.includes("preview")) continue;
    const candidate = { id, releaseDate: m.release_date ?? "" };
    if (!best || isNewer(candidate, best)) best = candidate;
  }
  return best ? `openrouter/${best.id}` : null;
}

/** Config shape errors: `model` and `modelAlias` are mutually exclusive, and the alias must parse. */
export function validateConfigModel(config: HarnessConfig): string[] {
  const errors: string[] = [];
  if (config.model !== undefined && config.modelAlias !== undefined) {
    errors.push("sets both model and modelAlias; pick one");
  }
  if (config.modelAlias !== undefined) {
    const parsed = parseAlias(config.modelAlias);
    if (!parsed) errors.push(`modelAlias "${config.modelAlias}" is not valid alias grammar`);
    else if (parsed.kind === "anthropic" && config.provider !== "claude") {
      errors.push(`modelAlias "${config.modelAlias}" needs provider claude`);
    } else if (
      parsed.kind === "openrouter" &&
      config.provider !== "pi" &&
      config.provider !== "opencode"
    ) {
      errors.push(`modelAlias "${config.modelAlias}" needs provider pi or opencode`);
    }
  }
  return errors;
}

/**
 * Read-time fallback for rows written before resolved models were recorded:
 * `latest:anthropic/opus` → the bare "opus" the harness used to receive, which
 * the analytics alias map then resolves like any historical bare alias.
 */
export function legacyAliasModel(alias: string): string | null {
  const parsed = parseAlias(alias);
  return parsed?.kind === "anthropic" ? parsed.family : null;
}
