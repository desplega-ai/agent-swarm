/** TypeScript types for the Linear integration. */

/** Stored OAuth token row from `linear_oauth_tokens`. */
export interface LinearOAuthToken {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO-8601
  scope: string;
  createdAt: string;
  updatedAt: string;
}

/** Row from `linear_sync` mapping swarm entities to Linear entities. */
export interface LinearSyncMapping {
  id: string;
  entityType: "task" | "epic";
  swarmId: string;
  linearId: string;
  linearIdentifier: string | null; // e.g. "SWARM-123"
  linearUrl: string | null;
  lastSyncedAt: string;
  syncDirection: "outbound" | "inbound" | "bidirectional";
  createdAt: string;
}

/** Row from `linear_agent_mapping`. */
export interface LinearAgentMapping {
  id: string;
  agentId: string;
  linearUserId: string;
  agentName: string;
  createdAt: string;
}

/** Shape returned by the Linear OAuth token endpoint. */
export interface LinearTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds
  scope: string;
  refresh_token?: string;
}

/** Pending OAuth state stored in-memory until callback completes. */
export interface PendingOAuthState {
  codeVerifier: string;
  createdAt: number; // Date.now()
}
