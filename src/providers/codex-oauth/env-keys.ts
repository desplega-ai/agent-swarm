/**
 * Codex OAuth swarm_config rows that must never reach a process env.
 *
 * `codex_oauth` (legacy) and `codex_oauth_<n>` (pool slots) hold the full
 * credential JSON, refresh token included. OpenAI revokes the whole token
 * family when a refresh token is replayed, so any process that can read env
 * could kill a pool slot for every worker. The runner reads these rows on
 * demand through `storage.ts` and writes auth.json with the refresh token
 * blanked, so env never needs them.
 *
 * Readers that only need to know a pool exists use the non-secret
 * `CODEX_OAUTH_POOL_SLOTS_ENV` count instead.
 *
 * Mirrored by the swarm_config export filter in `docker-entrypoint.sh`.
 */

const CODEX_OAUTH_CONFIG_KEY = /^codex_oauth(_\d+)?$/;
const CODEX_OAUTH_POOL_SLOT_KEY = /^codex_oauth_\d+$/;
const CODEX_OAUTH_LEGACY_KEY = "codex_oauth";
const CODEX_OAUTH_SLOT0_KEY = "codex_oauth_0";

/**
 * Env var carrying the number of usable `codex_oauth_<n>` slots. Not a secret.
 * A legacy `codex_oauth` row counts as slot 0 when no `codex_oauth_0` row has a
 * value, matching `loadAllCodexOAuthSlots()` in `storage.ts`.
 */
export const CODEX_OAUTH_POOL_SLOTS_ENV = "CODEX_OAUTH_POOL_SLOTS";

/** True for the legacy `codex_oauth` key and every `codex_oauth_<n>` slot. */
export function isCodexOAuthConfigKey(key: string): boolean {
  return CODEX_OAUTH_CONFIG_KEY.test(key);
}

function hasAccessToken(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.access === "string" && parsed.access.length > 0;
  } catch {
    // Unparseable slot: not usable, not counted.
    return false;
  }
}

/**
 * Pool slots whose value carries a non-empty access token. The legacy
 * `codex_oauth` row stands in for slot 0 only when no `codex_oauth_0` row has a
 * value, so the two are never double-counted.
 */
export function countCodexOAuthPoolSlots(configs: Array<{ key: string; value: string }>): number {
  let count = 0;
  let hasSlot0 = false;
  for (const { key, value } of configs) {
    if (!CODEX_OAUTH_POOL_SLOT_KEY.test(key)) continue;
    if (key === CODEX_OAUTH_SLOT0_KEY && value) hasSlot0 = true;
    if (hasAccessToken(value)) count++;
  }
  if (!hasSlot0) {
    const legacy = configs.find((c) => c.key === CODEX_OAUTH_LEGACY_KEY);
    if (legacy?.value && hasAccessToken(legacy.value)) count++;
  }
  return count;
}

/** True when the loader recorded at least one usable pool slot. */
export function hasCodexOAuthPoolSlots(env: Record<string, string | undefined>): boolean {
  return Number(env[CODEX_OAUTH_POOL_SLOTS_ENV] ?? 0) > 0;
}
