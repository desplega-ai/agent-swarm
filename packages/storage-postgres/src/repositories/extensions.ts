import { BaseExtensionsRepository, type ExtensionRunRow, sql } from "@desplega/storage";

export class PostgresExtensionsRepository extends BaseExtensionsRepository {
  async pruneRuns(extensionId: string, keep: number): Promise<void> {
    await this.db.run(sql`
      DELETE FROM extension_runs
      WHERE "extensionId" = ${extensionId} AND id IN (
        SELECT id FROM extension_runs
        WHERE "extensionId" = ${extensionId}
        ORDER BY "createdAt" DESC, "_rowid" DESC
        OFFSET ${keep}
      )`);
  }

  listRuns(extensionId: string, limit: number): Promise<ExtensionRunRow[]> {
    return this.db.query<ExtensionRunRow>(sql`
      SELECT * FROM extension_runs
      WHERE "extensionId" = ${extensionId}
      ORDER BY "createdAt" DESC, "_rowid" DESC
      LIMIT ${limit}`);
  }
}
