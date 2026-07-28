/**
 * Shared boolean-env parser.
 *
 * Motivation: the swarm exposes boolean settings through three writers that
 * historically disagreed on serialization — deployment `.env` files (any of
 * `true`/`1`/`yes`), the MCP `set-config` tool (free-form strings), and the
 * dashboard's Configuration page, which always writes exactly `"true"` /
 * `"false"`. Consumers that hand-rolled their own check drifted apart: some
 * only treated `"0"` as false (so a dashboard-written `"false"` left the flag
 * ON), others only treated `"true"` as true (so a `.env` `1` did nothing).
 *
 * This module is the single parse. Keep it dependency-free and outside
 * `src/be` so worker-side code (commands, providers, prompts) can import it
 * without crossing the DB boundary.
 *
 * Semantics:
 *   truthy → "true" | "1"   (case-insensitive, trimmed)
 *   falsy  → "false" | "0"  (case-insensitive, trimmed)
 *   absent, empty, or unrecognized → `defaultValue`
 *
 * Unrecognized values fall back to the default rather than silently reading as
 * `false`, so a typo'd `"treu"` can't quietly disable a default-on safety
 * feature.
 */

const TRUTHY: ReadonlySet<string> = new Set(["true", "1"]);
const FALSY: ReadonlySet<string> = new Set(["false", "0"]);

/**
 * Parse a raw env-style flag value.
 *
 * @param raw          The raw value (typically `process.env.SOME_FLAG`).
 * @param defaultValue Result when `raw` is absent, empty, or unrecognized.
 */
export function parseEnvFlag(raw: string | undefined | null, defaultValue: boolean): boolean {
  if (raw === undefined || raw === null) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return defaultValue;
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return defaultValue;
}

/**
 * Read a boolean flag straight off an env bag (defaults to `process.env`).
 * Always reads dynamically — never capture the result in a module-level
 * const, or a `swarm_config` reload can't take effect.
 */
export function isEnvFlagEnabled(
  key: string,
  defaultValue: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseEnvFlag(env[key], defaultValue);
}
