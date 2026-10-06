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

/** Env var carrying the number of usable `codex_oauth_<n>` slots. Not a secret. */
export const CODEX_OAUTH_POOL_SLOTS_ENV = "CODEX_OAUTH_POOL_SLOTS";

/** True for the legacy `codex_oauth` key and every `codex_oauth_<n>` slot. */
export function isCodexOAuthConfigKey(key: string): boolean {
  return CODEX_OAUTH_CONFIG_KEY.test(key);
}

/** Pool slots whose value carries a non-empty access token. */
export function countCodexOAuthPoolSlots(configs: Array<{ key: string; value: string }>): number {
  let count = 0;
  for (const { key, value } of configs) {
    if (!CODEX_OAUTH_POOL_SLOT_KEY.test(key)) continue;
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed?.access === "string" && parsed.access.length > 0) count++;
    } catch {
      // Unparseable slot: not usable, not counted.
    }
  }
  return count;
}

/** True when the loader recorded at least one usable pool slot. */
export function hasCodexOAuthPoolSlots(env: Record<string, string | undefined>): boolean {
  return Number(env[CODEX_OAUTH_POOL_SLOTS_ENV] ?? 0) > 0;
}
