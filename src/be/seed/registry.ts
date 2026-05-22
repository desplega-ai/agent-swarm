/**
 * The seeder registry — every concrete {@link Seeder} wired into the swarm.
 *
 * To make a new entity kind seedable: implement a `Seeder`, add it here, done.
 * The harness ({@link ./runner}) and the boot/CLI entry points pick it up
 * automatically. Scripts is the only kind today.
 */

import { scriptsSeeder } from "../seed-scripts";
import { runSeeders } from "./runner";
import type { Seeder, SeederResult } from "./types";

export const SEEDERS: Seeder[] = [scriptsSeeder];

/** Apply every registered seeder. Called at API boot and by the seed CLI. */
export function runAllSeeders(opts?: { quiet?: boolean }): Promise<SeederResult[]> {
  return runSeeders(SEEDERS, opts);
}
