import { BaseRbacRepository, sql } from "@desplega/storage";

export class SqliteRbacRepository extends BaseRbacRepository {
  async purgeAuditOlderThanDays(days: number): Promise<number> {
    // ts is CURRENT_TIMESTAMP text ("YYYY-MM-DD HH:MM:SS"); datetime() writes
    // the cutoff in the same format.
    const result = await this.db.run(
      sql`DELETE FROM permission_audit WHERE ts < datetime('now', ${`-${days} days`})`,
    );
    return result.changes;
  }
}
