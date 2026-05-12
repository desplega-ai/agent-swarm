import { ProviderNameSchema } from "../types";

/**
 * Guards against storing reserved keys in the swarm_config table.
 *
 * `API_KEY` and `SECRETS_ENCRYPTION_KEY` must live only in the process
 * environment (or a .env file) — persisting them in swarm_config would
 * create a chicken-and-egg problem:
 *   - `API_KEY` controls access to the HTTP API that reads swarm_config.
 *   - `SECRETS_ENCRYPTION_KEY` is required to decrypt secrets stored in
 *     swarm_config, so it cannot itself be stored encrypted there.
 *
 * Matching is case-insensitive so `api_key`, `Api_Key`, etc. are all
 * rejected at every write path (DB helpers, HTTP routes, MCP tools).
 */
const RESERVED_KEYS = new Set(["API_KEY", "SECRETS_ENCRYPTION_KEY"]);

export function isReservedConfigKey(key: string): boolean {
  return RESERVED_KEYS.has(key.toUpperCase());
}

export function reservedKeyError(key: string): Error {
  return new Error(
    `Key '${key}' is reserved and cannot be stored in swarm_config. ` +
      `Set it as an environment variable instead.`,
  );
}

/**
 * Per-key value validators run on `upsertSwarmConfig` writes via the HTTP
 * config API. Use this when an invalid value would silently break workers
 * (e.g. typo'd HARNESS_PROVIDER would fall back to "claude" with only a
 * console.warn — the operator wouldn't see why their config was ignored).
 *
 * Returns a human-readable error string when the value is invalid, or
 * `null` when the key has no validator or the value passes.
 */
const VALIDATED_KEYS: Record<string, (value: unknown) => string | null> = {
  HARNESS_PROVIDER: (value) => {
    const parsed = ProviderNameSchema.safeParse(value);
    if (parsed.success) return null;
    return `Invalid HARNESS_PROVIDER value (must be one of: ${ProviderNameSchema.options.join(", ")})`;
  },
};

export function validateConfigValue(key: string, value: unknown): string | null {
  const validator = VALIDATED_KEYS[key.toUpperCase()];
  return validator ? validator(value) : null;
}
