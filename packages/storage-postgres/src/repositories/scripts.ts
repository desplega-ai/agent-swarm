import type {
  NewScriptRunJournalStep,
  ScriptRunJournalRow,
  ScriptRunListFilter,
  ScriptRunListRow,
  ScriptRunRow,
} from "@desplega/storage";
import {
  BaseScriptsRepository,
  jsonText,
  type ScriptApiRow,
  type ScriptCredentialBindingRow,
  type ScriptEmbeddingCandidateRow,
  type ScriptRow,
  type ScriptSearchScope,
  sql,
} from "@desplega/storage";

/** The embedding columns as NULL, for a script row read without its embedding. */
const NO_EMBEDDING = sql`NULL AS "scriptId", NULL AS embedding, NULL AS "embeddingModel", NULL AS "embeddedText", NULL AS "embeddedAt"`;

export class PostgresScriptsRepository extends BaseScriptsRepository {
  // The SQLite override's orders, with "_rowid" for rowid.

  listEmbeddedScripts(scope: ScriptSearchScope): Promise<ScriptEmbeddingCandidateRow[]> {
    return this.db.query<ScriptEmbeddingCandidateRow>(sql`
      SELECT s.*, e."scriptId", e.embedding, e."embeddingModel", e."embeddedText", e."embeddedAt"
      FROM script_embeddings e
      JOIN scripts s ON s.id = e."scriptId"
      WHERE s."isScratch" = ${false} AND ${this.searchScopeSql(scope, "s.")}
      ORDER BY s."createdAt", s."_rowid"`);
  }

  listSearchableScripts(scope: ScriptSearchScope): Promise<ScriptEmbeddingCandidateRow[]> {
    return this.db.query<ScriptEmbeddingCandidateRow>(sql`
      SELECT *, ${NO_EMBEDDING} FROM scripts
      WHERE "isScratch" = ${false} AND ${this.searchScopeSql(scope, "")}
      ORDER BY "createdAt", "_rowid"`);
  }

  listScriptsForReembed(): Promise<ScriptEmbeddingCandidateRow[]> {
    return this.db.query<ScriptEmbeddingCandidateRow>(sql`
      SELECT *, ${NO_EMBEDDING} FROM scripts
      WHERE "isScratch" = ${false}
      ORDER BY "updatedAt" ASC, "createdAt", "_rowid"`);
  }

  listScriptsMissingEmbedding(): Promise<ScriptRow[]> {
    return this.db.query<ScriptRow>(sql`
      SELECT s.* FROM scripts s
      LEFT JOIN script_embeddings e ON e."scriptId" = s.id
      WHERE s."isScratch" = ${false} AND e."scriptId" IS NULL
      ORDER BY s."createdAt", s."_rowid"`);
  }

  listScriptsWithEmbeddingSizeNot(bytes: number): Promise<ScriptRow[]> {
    return this.db.query<ScriptRow>(sql`
      SELECT s.* FROM scripts s
      JOIN script_embeddings e ON e."scriptId" = s.id
      WHERE s."isScratch" = ${false} AND octet_length(e.embedding) != ${bytes}
      ORDER BY s."createdAt", s."_rowid"`);
  }

  listScriptApisForScript(scriptId: string): Promise<ScriptApiRow[]> {
    return this.db.query<ScriptApiRow>(sql`
      SELECT * FROM script_apis WHERE "scriptId" = ${scriptId}
      ORDER BY "createdAt" DESC, "_rowid" ASC`);
  }

  listCredentialBindings(): Promise<ScriptCredentialBindingRow[]> {
    return this.db.query<ScriptCredentialBindingRow>(
      sql`SELECT * FROM script_credential_bindings ORDER BY config_key ASC, "_rowid" ASC`,
    );
  }

  async deferForeignKeys(): Promise<void> {
    // Defers the DEFERRABLE constraints to commit, as SQLite's PRAGMA defers
    // every foreign key for the current transaction.
    await this.db.run(sql`SET CONSTRAINTS ALL DEFERRED`);
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
      ORDER BY "startedAt" DESC, "_rowid" DESC
      LIMIT ${limit} OFFSET ${offset}`);
  }

  listActiveScriptRuns(): Promise<ScriptRunRow[]> {
    return this.db.query<ScriptRunRow>(
      sql`${this.scriptRunSelect} WHERE r.status IN ('running', 'paused') ORDER BY r."_rowid"`,
    );
  }

  async insertScriptRunJournalStep(r: NewScriptRunJournalStep): Promise<void> {
    // SQLite stamps datetime('now') (whole seconds) for startedAt (its DEFAULT)
    // and completedAt; truncating keeps the same instants and the same ties.
    await this.db.run(sql`
      INSERT INTO script_run_journal
        (id, "runId", "stepKey", "stepType", config, status, result, error, "durationMs",
         "startedAt", "completedAt")
      VALUES (${r.id}, ${r.runId}, ${r.stepKey}, ${r.stepType}, ${jsonText(r.config)}, ${r.status},
        ${r.result}, ${r.error}, ${r.durationMs}, date_trunc('second', statement_timestamp()),
        date_trunc('second', statement_timestamp()))
      ON CONFLICT DO NOTHING`);
  }

  listScriptRunJournalSteps(runId: string): Promise<ScriptRunJournalRow[]> {
    return this.db.query<ScriptRunJournalRow>(sql`
      SELECT * FROM script_run_journal WHERE "runId" = ${runId} ORDER BY "startedAt" ASC, "_rowid" ASC`);
  }
}
