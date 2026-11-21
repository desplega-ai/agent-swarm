import type {
  NewScriptRunJournalStep,
  ScriptRunJournalRow,
  ScriptRunListFilter,
  ScriptRunListRow,
  ScriptRunRow,
} from "@desplega/storage";
import {
  BaseScriptsRepository,
  type ScriptApiRow,
  type ScriptCredentialBindingRow,
  type ScriptEmbeddingCandidateRow,
  type ScriptRow,
  type ScriptSearchScope,
  sql,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

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
    return notOnPostgresYet("PostgresScriptsRepository.listScriptRuns");
  }

  listActiveScriptRuns(): Promise<ScriptRunRow[]> {
    return notOnPostgresYet("PostgresScriptsRepository.listActiveScriptRuns");
  }

  insertScriptRunJournalStep(row: NewScriptRunJournalStep): Promise<void> {
    return notOnPostgresYet("PostgresScriptsRepository.insertScriptRunJournalStep");
  }

  listScriptRunJournalSteps(runId: string): Promise<ScriptRunJournalRow[]> {
    return notOnPostgresYet("PostgresScriptsRepository.listScriptRunJournalSteps");
  }
}
