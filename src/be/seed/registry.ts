/**
 * The seeder registry — every concrete {@link Seeder} wired into the swarm.
 *
 * To make a new entity kind seedable: implement a `Seeder`, add it here, done.
 * The harness ({@link ./runner}) and the boot/CLI entry points pick it up
 * automatically.
 */

import { scriptsSeeder } from "../seed-scripts";
import { skillsSeeder } from "../seed-skills";
import { agentFsProvisionSeeder } from "./agent-fs-provision";
import { runSeeders } from "./runner";
import { createSchedulesSeeder } from "./schedules-seeder";
import {
  isSeedSchedulesEnabled,
  isSeedScriptsEnabled,
  isSeedSkillsEnabled,
  isSeedWorkflowsEnabled,
} from "./seed-toggle";
import type { Seeder, SeederResult, SeederRunOptions } from "./types";
import { workflowsSeeder } from "./workflows-seeder";

/**
 * Build the active seeder list from the per-kind opt-out flags (see
 * {@link ./seed-toggle}). `agentFsProvisionSeeder` always runs: it provisions
 * storage the swarm needs to boot, regardless of catalog-content preference.
 */
export function buildSeeders(env: NodeJS.ProcessEnv = process.env): Seeder[] {
  const seeders: Seeder[] = [agentFsProvisionSeeder];
  if (isSeedScriptsEnabled(env)) seeders.push(scriptsSeeder);
  if (isSeedSkillsEnabled(env)) seeders.push(skillsSeeder);
  if (isSeedWorkflowsEnabled(env)) seeders.push(workflowsSeeder);
  if (isSeedSchedulesEnabled(env)) seeders.push(createSchedulesSeeder(undefined, env));
  return seeders;
}

/**
 * Every registered seeder under the env read at module load. Like
 * `SEED_AUTOMATIONS_ENABLED`, these flags are restart-required: flip one and
 * restart the process to change what the next boot/CLI seed pass includes.
 */
export const SEEDERS: Seeder[] = buildSeeders();

/** Apply every registered seeder. Called at API boot and by the seed CLI. */
export function runAllSeeders(opts?: SeederRunOptions): Promise<SeederResult[]> {
  return runSeeders(SEEDERS, opts);
}
