import { getDbClient, getSwarmConfigs, upsertSwarmConfig } from "./db";
import { wasDbCreatedThisBoot } from "./db/runtime";
import { DB_RETENTION_TABLES } from "./db-retention";

/**
 * New-install seed: store each table's `newInstallDefault` as a global
 * swarm_config row, so retention is on from the first boot and the operator
 * sees and edits the values like any other stored setting.
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
  const seeded: string[] = [];
  // One transaction: a failure must not leave a partial set that no later boot completes.
  await getDbClient().transaction(async () => {
    for (const table of DB_RETENTION_TABLES) {
      // Presence, not truthiness: an empty or blank env value is the operator's
      // explicit "off" and must not be replaced by a deleting default.
      if (!("newInstallDefault" in table) || process.env[table.envKey] !== undefined) continue;
      const existing = await getSwarmConfigs({ scope: "global", key: table.envKey });
      if (existing.length > 0) continue;
      await upsertSwarmConfig({
        scope: "global",
        key: table.envKey,
        value: String(table.newInstallDefault),
        description: `New-install default: ${table.table} retention. Rows past it are permanently deleted. Delete this entry to turn the sweep off.`,
      });
      seeded.push(`${table.envKey}=${table.newInstallDefault}`);
    }
  });
  if (seeded.length > 0) {
    console.log(
      `[startup] New database: stored default retention (${seeded.join(", ")}). Rows past these limits are permanently deleted; change or delete each key in Settings → Configuration.`,
    );
  }
  return seeded;
}
