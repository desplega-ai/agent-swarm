// Pure helpers for deriving integration status from the swarm_config snapshot.
//
// Status semantics (see Plan: thoughts/taras/plans/2026-04-21-integrations-ui.md):
//   - "disabled"   — `<disableKey>` is set to a truthy value ("true" | "1" | "yes").
//   - "configured" — all required fields have a non-empty value present.
//   - "partial"    — at least one required field is present but not all.
//   - "none"       — no required fields are present.
//
// Reserved keys (`API_KEY`, `SECRETS_ENCRYPTION_KEY`) are filtered out
// defensively — they should never land in `swarm_config`, but if somehow a row
// appears we skip it so it can't influence status.

import type { SwarmConfig } from "@/api/types";
import type { IntegrationDef, IntegrationField } from "./integrations-catalog";

export type IntegrationStatus = "configured" | "partial" | "disabled" | "none";

/**
 * Map of env-var key → whether it's set in the API server's `process.env`.
 * Sourced from `GET /api/config/env-presence`. Empty when the endpoint has
 * not loaded yet — status derivation then falls back to DB-only presence.
 */
export type EnvPresence = Readonly<Record<string, boolean>>;

const RESERVED_KEYS: ReadonlySet<string> = new Set(["api_key", "secrets_encryption_key"]);

const TRUTHY_VALUES: ReadonlySet<string> = new Set(["true", "1", "yes"]);

function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key.toLowerCase());
}

/**
 * Find the `SwarmConfig` row for a given key in the global scope.
 * Returns `undefined` if no row exists, the value is empty, or the key is
 * reserved (defense-in-depth).
 */
export function findConfigForKey(configs: SwarmConfig[], key: string): SwarmConfig | undefined {
  if (isReservedKey(key)) return undefined;
  return configs.find((c) => c.scope === "global" && c.key === key && c.value.length > 0);
}

/**
 * Derive an integration's status from the global `swarm_config` snapshot.
 *
 * Precedence:
 *   1. If `disableKey` resolves to a truthy value → "disabled".
 *   2. If all required fields are present → "configured".
 *   3. If some (but not all) required fields are present → "partial".
 *   4. Otherwise → "none".
 *
 * An integration with zero required fields is considered "configured" when at
 * least one non-required field is set, otherwise "none". This handles cases
 * like `codex-oauth` where the only signal is the presence of the row.
 */
function isFieldPresent(key: string, configs: SwarmConfig[], envPresence: EnvPresence): boolean {
  if (isReservedKey(key)) return false;
  if (findConfigForKey(configs, key) !== undefined) return true;
  return envPresence[key] === true;
}

export function deriveIntegrationStatus(
  def: IntegrationDef,
  configs: SwarmConfig[],
  envPresence: EnvPresence = {},
): IntegrationStatus {
  // Disabled signal: only derivable from DB rows (env-presence is boolean-only,
  // so we can't tell <PREFIX>_DISABLE=true from =false when set via deploy env).
  if (def.disableKey) {
    const disableCfg = findConfigForKey(configs, def.disableKey);
    if (disableCfg && TRUTHY_VALUES.has(disableCfg.value.trim().toLowerCase())) {
      return "disabled";
    }
  }

  const requiredFields: IntegrationField[] = def.fields.filter(
    (f) => f.required === true && !isReservedKey(f.key),
  );
  const advancedFields: IntegrationField[] = def.fields.filter(
    (f) => f.advanced === true && !isReservedKey(f.key),
  );

  const allFieldsPresent = def.fields.some((f) => isFieldPresent(f.key, configs, envPresence));

  if (requiredFields.length === 0) {
    return allFieldsPresent ? "configured" : "none";
  }

  const requiredPresentCount = requiredFields.reduce(
    (acc, f) => acc + (isFieldPresent(f.key, configs, envPresence) ? 1 : 0),
    0,
  );
  const advancedPresentCount = advancedFields.reduce(
    (acc, f) => acc + (isFieldPresent(f.key, configs, envPresence) ? 1 : 0),
    0,
  );

  if (requiredPresentCount === requiredFields.length) return "configured";
  // Alt-mode: no required set but an advanced path is in use (e.g. GitHub App
  // mode sets GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY instead of GITHUB_TOKEN).
  // Count the integration as configured as long as SOMETHING is set.
  if (requiredPresentCount === 0 && advancedPresentCount > 0) return "configured";
  if (requiredPresentCount === 0 && !allFieldsPresent) return "none";
  return "partial";
}
