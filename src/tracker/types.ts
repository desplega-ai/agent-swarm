export type TrackerProvider = "linear"; // extend as providers are added

export interface OAuthApp {
  id: string;
  provider: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface TrackerSync {
  id: string;
  provider: string;
  entityType: "task" | "epic";
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
