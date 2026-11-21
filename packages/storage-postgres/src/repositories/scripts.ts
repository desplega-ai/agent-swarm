import {
  BaseScriptsRepository,
  type ScriptApiRow,
  type ScriptCredentialBindingRow,
  type ScriptEmbeddingCandidateRow,
  type ScriptRow,
  type ScriptSearchScope,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresScriptsRepository extends BaseScriptsRepository {
  listEmbeddedScripts(scope: ScriptSearchScope): Promise<ScriptEmbeddingCandidateRow[]> {
    return notOnPostgresYet("PostgresScriptsRepository.listEmbeddedScripts");
  }

  listSearchableScripts(scope: ScriptSearchScope): Promise<ScriptEmbeddingCandidateRow[]> {
    return notOnPostgresYet("PostgresScriptsRepository.listSearchableScripts");
  }

  listScriptsForReembed(): Promise<ScriptEmbeddingCandidateRow[]> {
    return notOnPostgresYet("PostgresScriptsRepository.listScriptsForReembed");
  }

  listScriptsMissingEmbedding(): Promise<ScriptRow[]> {
    return notOnPostgresYet("PostgresScriptsRepository.listScriptsMissingEmbedding");
  }

  listScriptsWithEmbeddingSizeNot(bytes: number): Promise<ScriptRow[]> {
    return notOnPostgresYet("PostgresScriptsRepository.listScriptsWithEmbeddingSizeNot");
  }

  listScriptApisForScript(scriptId: string): Promise<ScriptApiRow[]> {
    return notOnPostgresYet("PostgresScriptsRepository.listScriptApisForScript");
  }

  listCredentialBindings(): Promise<ScriptCredentialBindingRow[]> {
    return notOnPostgresYet("PostgresScriptsRepository.listCredentialBindings");
  }

  deferForeignKeys(): Promise<void> {
    return notOnPostgresYet("PostgresScriptsRepository.deferForeignKeys");
  }
}
