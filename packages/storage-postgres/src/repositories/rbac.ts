import { BaseRbacRepository, sql } from "@desplega/storage";

export class PostgresRbacRepository extends BaseRbacRepository {
  async purgeAuditOlderThanDays(days: number): Promise<number> {
    const result = await this.db.run(sql`
      DELETE FROM permission_audit
       WHERE ts < statement_timestamp() - CAST(${days} AS double precision) * interval '1 day'`);
    return result.changes;
  }

  /** The baseline creates `trg_users_default_role` (a PL/pgSQL trigger): nothing to do. */
  async ensureDefaultRoleTrigger(): Promise<void> {}
}
