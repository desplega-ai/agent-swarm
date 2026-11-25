import type { SqlExecutor } from "../executor";
import { sql } from "../sql";

export type ScriptRunnerCredential = {
  id: string;
  name: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

export interface ScriptRunnersRepository {
  insert(row: ScriptRunnerCredential, tokenHash: string): Promise<void>;
  list(): Promise<ScriptRunnerCredential[]>;
  findActiveByHash(tokenHash: string, now: string): Promise<ScriptRunnerCredential | null>;
  revoke(id: string, now: string, actor: string | null): Promise<boolean>;
}

const COLUMNS = sql`id, name, expires_at AS "expiresAt", revoked_at AS "revokedAt",
  created_at AS "createdAt", updated_at AS "updatedAt",
  created_by AS "createdBy", updated_by AS "updatedBy"`;

export class BaseScriptRunnersRepository implements ScriptRunnersRepository {
  constructor(protected readonly db: SqlExecutor) {}

  async insert(row: ScriptRunnerCredential, tokenHash: string): Promise<void> {
    await this.db.run(sql`INSERT INTO script_runner_credentials
      (id, name, token_hash, expires_at, revoked_at, created_at, updated_at, created_by, updated_by, issuer_user_id)
      VALUES (${row.id}, ${row.name}, ${tokenHash}, ${row.expiresAt}, ${row.revokedAt},
        ${row.createdAt}, ${row.updatedAt}, ${row.createdBy}, ${row.updatedBy}, ${row.createdBy})`);
  }

  list(): Promise<ScriptRunnerCredential[]> {
    return this.db.query<ScriptRunnerCredential>(sql`SELECT ${COLUMNS}
      FROM script_runner_credentials ORDER BY created_at, id`);
  }

  findActiveByHash(tokenHash: string, now: string): Promise<ScriptRunnerCredential | null> {
    return this.db.get<ScriptRunnerCredential>(sql`SELECT ${COLUMNS}
      FROM script_runner_credentials WHERE token_hash = ${tokenHash}
      AND revoked_at IS NULL AND expires_at > ${now}
      AND ((issuer_user_id IS NULL AND created_by IS NULL)
        OR (issuer_user_id <> '' AND issuer_user_id = created_by))`);
  }

  async revoke(id: string, now: string, actor: string | null): Promise<boolean> {
    const result = await this.db.run(sql`UPDATE script_runner_credentials
      SET revoked_at = ${now}, updated_at = ${now},
        updated_by = ${actor} WHERE id = ${id} AND revoked_at IS NULL`);
    if (result.changes > 0) return true;
    return !!(await this.db.get(sql`SELECT id FROM script_runner_credentials WHERE id = ${id}`));
  }
}
