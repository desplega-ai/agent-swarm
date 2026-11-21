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

  async ensureDefaultRoleTrigger(): Promise<void> {
    await this.db.run(sql`
      CREATE TRIGGER IF NOT EXISTS trg_users_default_role
      AFTER INSERT ON users
      BEGIN
        INSERT OR IGNORE INTO principal_roles ("principalType", "principalId", "roleId")
        SELECT 'user', NEW.id, 'rbac-role-admin'
        WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'rbac-role-admin');
      END`);
  }
}
