/**
 * Generic entity-seeder framework. See {@link ./types} for the `Seeder`
 * contract and the versioning rule the harness enforces.
 */

export { runAllSeeders, SEEDERS } from "./registry";
export { runSeeder, runSeeders } from "./runner";
export { getSeedState, recordSeedState } from "./state-db";
export type { SeedAction, Seeder, SeederResult, SeederRunOptions, SeedItem } from "./types";
