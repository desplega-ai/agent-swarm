import { BaseModelsRepository, sql, type TaskHoldWindow } from "@desplega/storage";

/** The entries of profile `o`'s fallback list; unreadable JSON reads as an empty list. */
const FALLBACK_ENTRIES = sql`json_each(CASE WHEN json_valid(o.fallbacks) THEN o.fallbacks ELSE '[]' END)`;

export class SqliteModelsRepository extends BaseModelsRepository {
  async listProfilesWithFallback(name: string): Promise<string[]> {
    const rows = await this.db.query<{ name: string }>(sql`
      SELECT o.name FROM model_profiles o, ${FALLBACK_ENTRIES} j
       WHERE j.value = ${name} AND o.name <> ${name} ORDER BY o.name`);
    return rows.map((row) => row.name);
  }

  async deleteUnreferencedProfile(
    name: string,
    window: TaskHoldWindow,
    defaultConfigKey: string,
  ): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(sql`
      DELETE FROM model_profiles
       WHERE name = ${name}
         AND NOT EXISTS (
           SELECT 1 FROM agent_tasks t
            WHERE (t.profile = model_profiles.name OR t."resolvedProfile" = model_profiles.name)
              AND ${this.taskHolds(window)})
         AND NOT EXISTS (
           SELECT 1 FROM swarm_config
            WHERE scope = 'agent' AND key = ${defaultConfigKey} AND trim(value) = model_profiles.name)
         AND NOT EXISTS (
           SELECT 1 FROM scheduled_tasks s WHERE s.profile = model_profiles.name)
         AND NOT EXISTS (
           SELECT 1 FROM model_profiles o, ${FALLBACK_ENTRIES} j
            WHERE j.value = model_profiles.name AND o.name <> model_profiles.name)
         AND NOT EXISTS (
           SELECT 1 FROM model_group_members m WHERE m."profileName" = model_profiles.name)
       RETURNING id`);
    return row !== null;
  }
}
