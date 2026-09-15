/**
 * Shared "arrive enabled" policy for seeded workflows and schedules.
 *
 * Boot seeding always inventories every candidate automation (see
 * {@link ./workflows-seeder} / {@link ./schedules-seeder}). Whether a freshly
 * created item also arrives *enabled* is governed by three independent gates,
 * all of which must pass:
 *
 *   1. The operator switch (`SEED_AUTOMATIONS_ENABLED`) is on.
 *   2. The item is zero-config: no required integration (`requires`) and no
 *      required param/placeholder. An item needing a credential or a param it
 *      doesn't have would just fail on a stranger's cluster.
 *   3. The template itself doesn't recommend staying off (its JSON payload's
 *      `enabled` field is not explicitly `false`).
 *
 * An item that fails any gate stays disabled and inventoried, exactly as
 * before this switch existed.
 */

import type { AutomationIntegrationId } from "../../types";

const SEED_AUTOMATIONS_ENABLED_ENV = "SEED_AUTOMATIONS_ENABLED";

// Flip this to change the shipped default for every install path (Helm,
// docker-compose, bare `bun run start:http`) in one place. The Helm chart's
// `config.seedAutomationsEnabled` default should track this value.
const SEED_AUTOMATIONS_ENABLED_DEFAULT = true;

/** Gate 1: is the operator switch on? Env var wins; unset falls back to the shipped default. */
export function isSeedAutomationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SEED_AUTOMATIONS_ENABLED_ENV];
  if (raw === undefined || raw === "") return SEED_AUTOMATIONS_ENABLED_DEFAULT;
  return raw.toLowerCase() === "true" || raw === "1";
}

/** Gate 2: no required integration and no required param/placeholder. */
export function isZeroConfigAutomation(
  requires: readonly AutomationIntegrationId[],
  requiredParams: readonly string[],
): boolean {
  return requires.length === 0 && requiredParams.length === 0;
}

/**
 * Combine all three gates into the `enabled` value a seeded item should be
 * created/updated with.
 */
export function resolveSeededEnabled(params: {
  requires: readonly AutomationIntegrationId[];
  requiredParams: readonly string[];
  templateRecommendsEnabled: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return (
    isSeedAutomationsEnabled(params.env) &&
    isZeroConfigAutomation(params.requires, params.requiredParams) &&
    params.templateRecommendsEnabled
  );
}
