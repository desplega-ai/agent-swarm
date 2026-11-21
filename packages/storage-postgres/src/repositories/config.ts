import {
  type ApiKeyAdmissionRow,
  type ApiKeyRowFilter,
  type ApiKeyStatusRow,
  BaseConfigRepository,
  type SwarmConfigRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresConfigRepository extends BaseConfigRepository {
  listConfigs(filters: {
    scope?: string;
    scopeId?: string;
    key?: string;
  }): Promise<SwarmConfigRow[]> {
    return notOnPostgresYet("PostgresConfigRepository.listConfigs");
  }

  listGlobalConfigsExcept(excludedUpperKeys: readonly string[]): Promise<SwarmConfigRow[]> {
    return notOnPostgresYet("PostgresConfigRepository.listGlobalConfigsExcept");
  }

  listSecretConfigs(): Promise<{ key: string; value: string; encrypted: number }[]> {
    return notOnPostgresYet("PostgresConfigRepository.listSecretConfigs");
  }

  listCodexOauthConfigs(): Promise<{ key: string; value: string; encrypted: number }[]> {
    return notOnPostgresYet("PostgresConfigRepository.listCodexOauthConfigs");
  }

  listKeyLabels(): Promise<
    Pick<ApiKeyStatusRow, "keyType" | "keySuffix" | "name" | "plan" | "planSource">[]
  > {
    return notOnPostgresYet("PostgresConfigRepository.listKeyLabels");
  }

  listKeyStatuses(filters: {
    keyType?: string;
    scope?: string;
    scopeId?: string;
  }): Promise<ApiKeyStatusRow[]> {
    return notOnPostgresYet("PostgresConfigRepository.listKeyStatuses");
  }

  listAdmissionRows(filter: ApiKeyRowFilter): Promise<ApiKeyAdmissionRow[]> {
    return notOnPostgresYet("PostgresConfigRepository.listAdmissionRows");
  }

  listAgentScopeIdsWithValue(key: string, value: string): Promise<string[]> {
    return notOnPostgresYet("PostgresConfigRepository.listAgentScopeIdsWithValue");
  }

  listRepoNamesAndUrls(): Promise<{ name: string | null; url: string | null }[]> {
    return notOnPostgresYet("PostgresConfigRepository.listRepoNamesAndUrls");
  }
}
