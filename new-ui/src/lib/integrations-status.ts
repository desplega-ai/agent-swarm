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
export function deriveIntegrationStatus(
  def: IntegrationDef,
  configs: SwarmConfig[],
): IntegrationStatus {
  if (def.disableKey) {
    const disableCfg = findConfigForKey(configs, def.disableKey);
    if (disableCfg && TRUTHY_VALUES.has(disableCfg.value.trim().toLowerCase())) {
      return "disabled";
    }
  }

  const requiredFields: IntegrationField[] = def.fields.filter(
    (f) => f.required === true && !isReservedKey(f.key),
  );

  if (requiredFields.length === 0) {
    // No required fields — any present non-disable field counts as configured.
    const anyPresent = def.fields.some(
      (f) => !isReservedKey(f.key) && findConfigForKey(configs, f.key) !== undefined,
    );
    return anyPresent ? "configured" : "none";
  }

  const presentCount = requiredFields.reduce(
    (acc, f) => acc + (findConfigForKey(configs, f.key) ? 1 : 0),
    0,
  );

  if (presentCount === 0) return "none";
  if (presentCount === requiredFields.length) return "configured";
  return "partial";
}
