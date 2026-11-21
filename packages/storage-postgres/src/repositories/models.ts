import { BaseModelsRepository, sql, type TaskHoldWindow } from "@desplega/storage";

/**
 * The entries of profile `o`'s fallbacks (jsonb), as SQLite's `json_each`
 * yields them: an array's elements, an object's values, or a scalar itself.
 * Entries compare as jsonb against a JSON string, so a non-string entry never
 * equals a name (on SQLite `json_each` yields it as a number or NULL).
 */
const FALLBACK_ENTRIES = sql`LATERAL (
  SELECT e.value FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(o.fallbacks) = 'array' THEN o.fallbacks ELSE '[]'::jsonb END) e
  UNION ALL
  SELECT e.value FROM jsonb_each(
    CASE WHEN jsonb_typeof(o.fallbacks) = 'object' THEN o.fallbacks ELSE '{}'::jsonb END) e
  UNION ALL
  SELECT o.fallbacks WHERE jsonb_typeof(o.fallbacks) NOT IN ('array', 'object')) j(value)`;

export class PostgresModelsRepository extends BaseModelsRepository {
  async listProfilesWithFallback(name: string): Promise<string[]> {
    const rows = await this.db.query<{ name: string }>(sql`
      SELECT o.name FROM model_profiles o, ${FALLBACK_ENTRIES}
       WHERE j.value = to_jsonb(CAST(${name} AS text)) AND o.name <> ${name} ORDER BY o.name`);
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
           SELECT 1 FROM model_profiles o, ${FALLBACK_ENTRIES}
            WHERE j.value = to_jsonb(model_profiles.name) AND o.name <> model_profiles.name)
         AND NOT EXISTS (
           SELECT 1 FROM model_group_members m WHERE m."profileName" = model_profiles.name)
       RETURNING id`);
    return row !== null;
  }
}
