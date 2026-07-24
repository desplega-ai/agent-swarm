export type TrackerProvider = "linear" | "jira"; // extend as providers are added

export interface OAuthApp {
  id: string;
  provider: string;
  displayName: string | null;
  clientId: string;
  clientSecret: string;
  clientSecretEncrypted: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  userinfoUrl: string | null;
  redirectUri: string;
  scopes: string;
  scopeSeparator: string;
  tokenAuthStyle: "body" | "basic";
  tokenBodyFormat: "form" | "json";
  requiresRefreshTokenRotation: boolean;
  extraParamsJson: string | null;
  source: "manual" | "dcr" | "curated-prefill";
  mcpServerId: string | null;
  metadata: string; // JSON string
  createdAt: string;
  updatedAt: string;
}

export interface OAuthTokens {
  id: string;
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scope: string | null;
  tokenVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface TrackerSync {
  id: string;
  provider: string;
  entityType: "task";
  providerEntityType: string | null;
  swarmId: string;
  externalId: string;
  externalIdentifier: string | null;
  externalUrl: string | null;
  lastSyncedAt: string;
  lastSyncOrigin: "swarm" | "external" | null;
  lastDeliveryId: string | null;
  syncDirection: "inbound" | "outbound" | "bidirectional";
  createdAt: string;
}

export interface TrackerAgentMapping {
  id: string;
  provider: string;
  agentId: string;
  externalUserId: string;
  agentName: string;
  createdAt: string;
}
