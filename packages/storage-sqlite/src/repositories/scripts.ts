import {
  BaseScriptsRepository,
  type NewScriptRunJournalStep,
  type ScriptApiRow,
  type ScriptCredentialBindingRow,
  type ScriptEmbeddingCandidateRow,
  type ScriptRow,
  type ScriptRunJournalRow,
  type ScriptRunListFilter,
  type ScriptRunListRow,
  type ScriptRunRow,
  type ScriptSearchScope,
  sql,
} from "@desplega/storage";

/** The embedding columns as NULL, for a script row read without its embedding. */
const NO_EMBEDDING = sql`NULL AS "scriptId", NULL AS embedding, NULL AS "embeddingModel", NULL AS "embeddedText", NULL AS "embeddedAt"`;

export class SqliteScriptsRepository extends BaseScriptsRepository {
  // The orders below spell out what the idx_scripts_scratch (isScratch,
  // createdAt) scan returned before they were written down: createdAt, then rowid.

  listEmbeddedScripts(scope: ScriptSearchScope): Promise<ScriptEmbeddingCandidateRow[]> {
    return this.db.query<ScriptEmbeddingCandidateRow>(sql`
      SELECT s.*, e."scriptId", e.embedding, e."embeddingModel", e."embeddedText", e."embeddedAt"
      FROM script_embeddings e
      JOIN scripts s ON s.id = e."scriptId"
      WHERE s."isScratch" = ${false} AND ${this.searchScopeSql(scope, "s.")}
      ORDER BY s."createdAt", s.rowid`);
  }

  listSearchableScripts(scope: ScriptSearchScope): Promise<ScriptEmbeddingCandidateRow[]> {
    return this.db.query<ScriptEmbeddingCandidateRow>(sql`
      SELECT *, ${NO_EMBEDDING} FROM scripts
      WHERE "isScratch" = ${false} AND ${this.searchScopeSql(scope, "")}
      ORDER BY "createdAt", rowid`);
  }

  listScriptsForReembed(): Promise<ScriptEmbeddingCandidateRow[]> {
    return this.db.query<ScriptEmbeddingCandidateRow>(sql`
      SELECT *, ${NO_EMBEDDING} FROM scripts
      WHERE "isScratch" = ${false}
      ORDER BY "updatedAt" ASC, "createdAt", rowid`);
  }

  listScriptsMissingEmbedding(): Promise<ScriptRow[]> {
    return this.db.query<ScriptRow>(sql`
      SELECT s.* FROM scripts s
      LEFT JOIN script_embeddings e ON e."scriptId" = s.id
      WHERE s."isScratch" = ${false} AND e."scriptId" IS NULL
      ORDER BY s."createdAt", s.rowid`);
  }

  listScriptsWithEmbeddingSizeNot(bytes: number): Promise<ScriptRow[]> {
    return this.db.query<ScriptRow>(sql`
      SELECT s.* FROM scripts s
      JOIN script_embeddings e ON e."scriptId" = s.id
      WHERE s."isScratch" = ${false} AND length(e.embedding) != ${bytes}
      ORDER BY s."createdAt", s.rowid`);
  }

  listScriptApisForScript(scriptId: string): Promise<ScriptApiRow[]> {
    return this.db.query<ScriptApiRow>(sql`
      SELECT * FROM script_apis WHERE "scriptId" = ${scriptId}
      ORDER BY "createdAt" DESC, rowid ASC`);
  }

  listCredentialBindings(): Promise<ScriptCredentialBindingRow[]> {
    return this.db.query<ScriptCredentialBindingRow>(
      sql`SELECT * FROM script_credential_bindings ORDER BY config_key ASC, rowid ASC`,
    );
  }

  async deferForeignKeys(): Promise<void> {
    await this.db.run(sql`PRAGMA defer_foreign_keys = ON`);
  }

  listScriptRuns(
    f: ScriptRunListFilter,
    limit: number,
    offset: number,
  ): Promise<ScriptRunListRow[]> {
    return this.db.query<ScriptRunListRow>(sql`
      SELECT id, "agentId", "scriptName", kind, status, pid, "startedAt", "finishedAt", error,
        last_heartbeat_at, "idempotencyKey", "requestedByUserId", "objectScriptId", "objectId",
        "objectMethod"
      FROM script_runs${this.scriptRunWhere(f)}
      ORDER BY "startedAt" DESC, rowid DESC
      LIMIT ${limit} OFFSET ${offset}`);
  }

  listActiveScriptRuns(): Promise<ScriptRunRow[]> {
    return this.db.query<ScriptRunRow>(
      sql`${this.scriptRunSelect} WHERE r.status IN ('running', 'paused') ORDER BY r.rowid`,
    );
  }

  async insertScriptRunJournalStep(r: NewScriptRunJournalStep): Promise<void> {
    await this.db.run(sql`
      INSERT OR IGNORE INTO script_run_journal
        (id, "runId", "stepKey", "stepType", config, status, result, error, "durationMs", "completedAt")
      VALUES (${r.id}, ${r.runId}, ${r.stepKey}, ${r.stepType}, ${r.config}, ${r.status}, ${r.result},
        ${r.error}, ${r.durationMs}, datetime('now'))`);
  }

  listScriptRunJournalSteps(runId: string): Promise<ScriptRunJournalRow[]> {
    return this.db.query<ScriptRunJournalRow>(sql`
      SELECT * FROM script_run_journal WHERE "runId" = ${runId} ORDER BY "startedAt" ASC, rowid ASC`);
  }
}
