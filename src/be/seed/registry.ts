/**
 * The seeder registry — every concrete {@link Seeder} wired into the swarm.
 *
 * To make a new entity kind seedable: implement a `Seeder`, add it here, done.
 * The harness ({@link ./runner}) and the boot/CLI entry points pick it up
 * automatically.
 */

import { SEED_SCRIPTS, scriptsSeeder } from "../seed-scripts";
import { BUILT_IN_SKILL_SOURCES, skillsSeeder } from "../seed-skills";
import { ADDONS, type Addon } from "./addons";
import { agentFsProvisionSeeder } from "./agent-fs-provision";
import { runSeeders } from "./runner";
import { schedulesSeeder } from "./schedules-seeder";
import type { Seeder, SeederResult, SeederRunOptions } from "./types";
import { workflowsSeeder } from "./workflows-seeder";

export const SEEDERS: Seeder[] = [
  agentFsProvisionSeeder,
  scriptsSeeder,
  skillsSeeder,
  workflowsSeeder,
  schedulesSeeder,
];

/** Fail boot early when an add-on references a catalog entry that does not ship. */
export function assertAddonReferences(addons: readonly Addon[] = ADDONS): void {
  const skillNames = new Set(BUILT_IN_SKILL_SOURCES.map(({ config }) => config.name));
  const scriptNames = new Set(SEED_SCRIPTS.map((script) => script.name));

  // workflows.name and scheduled_tasks.name are UNIQUE and seed_state is keyed
  // (kind, key) with no addon dimension — a name shared by two add-ons would
  // silently overwrite the first add-on's entity via the update branch.
  const seenWorkflowNames = new Map<string, string>();
  const seenScheduleNames = new Map<string, string>();

  for (const addon of addons) {
    for (const workflow of addon.workflows) {
      const owner = seenWorkflowNames.get(workflow.name);
      if (owner !== undefined) {
        throw new Error(
          `Add-ons "${owner}" and "${addon.name}" both ship a workflow named "${workflow.name}"`,
        );
      }
      seenWorkflowNames.set(workflow.name, addon.name);
    }
    for (const schedule of addon.schedules) {
      const owner = seenScheduleNames.get(schedule.name);
      if (owner !== undefined) {
        throw new Error(
          `Add-ons "${owner}" and "${addon.name}" both ship a schedule named "${schedule.name}"`,
        );
      }
      seenScheduleNames.set(schedule.name, addon.name);
    }
    for (const skillName of addon.skillNames) {
      if (!skillNames.has(skillName)) {
        throw new Error(`Add-on "${addon.name}" references unknown seeded skill "${skillName}"`);
      }
    }
    for (const scriptName of addon.scriptNames) {
      if (!scriptNames.has(scriptName)) {
        throw new Error(`Add-on "${addon.name}" references unknown seeded script "${scriptName}"`);
      }
    }

    const workflowNames = new Set(addon.workflows.map((workflow) => workflow.name));
    for (const schedule of addon.schedules) {
      if (schedule.targetType === "workflow" && !workflowNames.has(schedule.workflowName)) {
        throw new Error(
          `Add-on "${addon.name}" schedule "${schedule.name}" references workflow "${schedule.workflowName}" outside the add-on`,
        );
      }
    }
  }
}

/** Apply every registered seeder. Called at API boot and by the seed CLI. */
export function runAllSeeders(opts?: SeederRunOptions): Promise<SeederResult[]> {
  assertAddonReferences();
  return runSeeders(SEEDERS, opts);
}
