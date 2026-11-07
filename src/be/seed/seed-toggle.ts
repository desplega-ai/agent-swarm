/**
 * Per-kind opt-out for the built-in seed catalog (scripts, skills, workflows,
 * schedules).
 *
 * Each flag defaults to `true`, reproducing pre-existing behavior when unset.
 * `agentFsProvisionSeeder` has no flag here: it provisions the shared-drive
 * storage the swarm needs to boot, and always runs — see {@link ./registry}.
 *
 * Distinct from `SEED_AUTOMATIONS_ENABLED` ({@link ./automation-toggle}),
 * which only gates whether a freshly seeded workflow/schedule arrives
 * *enabled* — the catalog row is still created either way. These flags gate
 * whether the catalog row is created at all, for installs whose content is
 * intentionally 100% externally managed.
 */

import { isEnvFlagEnabled } from "../../utils/env-flag";

export function isSeedScriptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvFlagEnabled("SEED_SCRIPTS_ENABLED", true, env);
}

export function isSeedSkillsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvFlagEnabled("SEED_SKILLS_ENABLED", true, env);
}

export function isSeedWorkflowsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvFlagEnabled("SEED_WORKFLOWS_ENABLED", true, env);
}

export function isSeedSchedulesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvFlagEnabled("SEED_SCHEDULES_ENABLED", true, env);
}
