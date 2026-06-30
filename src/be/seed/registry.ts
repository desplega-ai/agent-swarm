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
import type { Seeder, SeederResult, SeederRunOptions } from "./types";

export const SEEDERS: Seeder[] = [agentFsProvisionSeeder, scriptsSeeder, skillsSeeder];

/** Apply every registered seeder. Called at API boot and by the seed CLI. */
export function runAllSeeders(opts?: SeederRunOptions): Promise<SeederResult[]> {
  return runSeeders(SEEDERS, opts);
}
