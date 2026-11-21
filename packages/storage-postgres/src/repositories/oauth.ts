import {
  BaseOAuthRepository,
  type OAuthAppListingRow,
  type OAuthAppRow,
  type OAuthAuthorizationRow,
  type OAuthAuthorizationSweepRow,
  type OAuthKeepAliveRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresOAuthRepository extends BaseOAuthRepository {
  listApps(): Promise<OAuthAppRow[]> {
    return notOnPostgresYet("PostgresOAuthRepository.listApps");
  }

  getAppMetadata(provider: string): Promise<{ metadata: string | null } | null> {
    return notOnPostgresYet("PostgresOAuthRepository.getAppMetadata");
  }

  listAuthorizationsWithProvider(): Promise<(OAuthAuthorizationRow & { provider: string })[]> {
    return notOnPostgresYet("PostgresOAuthRepository.listAuthorizationsWithProvider");
  }

  listSweepRows(): Promise<OAuthAuthorizationSweepRow[]> {
    return notOnPostgresYet("PostgresOAuthRepository.listSweepRows");
  }

  listKeepAliveRows(): Promise<OAuthKeepAliveRow[]> {
    return notOnPostgresYet("PostgresOAuthRepository.listKeepAliveRows");
  }

  findLatestMcpPendingAppId(mcpServerId: string, userId: string | null): Promise<string | null> {
    return notOnPostgresYet("PostgresOAuthRepository.findLatestMcpPendingAppId");
  }

  listProviderAppsWithDefaultToken(): Promise<OAuthAppListingRow[]> {
    return notOnPostgresYet("PostgresOAuthRepository.listProviderAppsWithDefaultToken");
  }
}
