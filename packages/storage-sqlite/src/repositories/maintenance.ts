import { BaseMaintenanceRepository, sql } from "@desplega/storage";

export class SqliteMaintenanceRepository extends BaseMaintenanceRepository {
  async deleteSkippedBootScrubVersions(version: number): Promise<void> {
    await this.db.run(sql`
      DELETE FROM seed_state WHERE kind = 'maintenance'
        AND key GLOB 'boot-scrub-skipped-v*' AND CAST(substr(key, 21) AS INTEGER) <= ${version}`);
  }
}
