import { getSwarmConfigs, upsertSwarmConfig } from "./db";
import { wasDbCreatedThisBoot } from "./db/runtime";
import { DB_RETENTION_TABLES } from "./db-retention";
import { getStorage } from "./storage";

/** A non-retention setting a new install stores the same way as a retention default. */
type NewInstallConfigDefault = { key: string; value: string; description: string };

/**
 * Settings that are on for new installs only. An upgraded install keeps the
 * code default (the worktree reaper stays in `dry-run`), so nothing starts
 * deleting on a box whose operator never chose it.
 */
export const NEW_INSTALL_CONFIG_DEFAULTS: readonly NewInstallConfigDefault[] = [
  {
    key: "WORKTREE_REAPER_MODE",
    value: "on",
    description:
      "New-install default: the worktree reaper removes task worktrees whose tasks ended and that hold no unpushed work. Set dry-run to only log, or off to stop it.",
  },
];

/**
 * New-install seed: store each table's `newInstallDefault`, and each
 * NEW_INSTALL_CONFIG_DEFAULTS entry, as a global swarm_config row, so
 * retention is on from the first boot and the operator sees and edits the
 * values like any other stored setting.
 *
 * Only the boot that creates the database writes rows. An upgraded install
 * keeps retention exactly as it was, and a row the operator deletes is never
 * written again. A key present in the deployment env, even empty, is left to the env
 * (a stored row would override it), and so is a key that already has a row.
 *
 * Call before `loadGlobalConfigsIntoEnv`, while `process.env` still holds the
 * deployment values and so that the load injects the new rows.
 */
export async function seedDbRetentionDefaults(
  isNewInstall: boolean = wasDbCreatedThisBoot(),
): Promise<string[]> {
  if (!isNewInstall) return [];
  // One transaction: a failure must not leave a partial set that no later boot completes.
  const seeded = await getStorage().transaction(async () => {
    const defaults: NewInstallConfigDefault[] = [
      ...DB_RETENTION_TABLES.flatMap((table) =>
        "newInstallDefault" in table
          ? [
              {
                key: table.envKey,
                value: String(table.newInstallDefault),
                description: `New-install default: ${table.table} retention. Rows past it are permanently deleted. Delete this entry to turn the sweep off.`,
              },
            ]
          : [],
      ),
      ...NEW_INSTALL_CONFIG_DEFAULTS,
    ];
    const written: string[] = [];
    for (const { key, value, description } of defaults) {
      // Presence, not truthiness: an empty or blank env value is the operator's
      // explicit "off" and must not be replaced by a deleting default.
      if (process.env[key] !== undefined) continue;
      const existing = await getSwarmConfigs({ scope: "global", key });
      if (existing.length > 0) continue;
      await upsertSwarmConfig({ scope: "global", key, value, description });
      written.push(`${key}=${value}`);
    }
    return written;
  });
  if (seeded.length > 0) {
    console.log(
      `[startup] New database: stored new-install defaults (${seeded.join(", ")}). Rows past the retention limits are permanently deleted; change or delete each key in Settings → Configuration.`,
    );
  }
  return seeded;
}
