import { BaseMaintenanceRepository, nowText, sql } from "@desplega/storage";

export class SqliteMaintenanceRepository extends BaseMaintenanceRepository {
  async setState(key: string, value: string): Promise<void> {
    await this.db.run(sql`
      INSERT INTO seed_state (kind, key, "seededHash", "seededAt")
      VALUES ('maintenance', ${key}, ${value}, ${nowText})
      ON CONFLICT (kind, key) DO UPDATE SET "seededHash" = excluded."seededHash", "seededAt" = ${nowText}`);
  }

  async deleteSkippedBootScrubVersions(version: number): Promise<void> {
    await this.db.run(sql`
      DELETE FROM seed_state WHERE kind = 'maintenance'
        AND key GLOB 'boot-scrub-skipped-v*' AND CAST(substr(key, 21) AS INTEGER) <= ${version}`);
  }
}
