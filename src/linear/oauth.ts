import { upsertKv } from "../be/db";
import { getOAuthApp } from "../be/db-queries/oauth";
import { oauthAppRowToProviderConfig } from "../oauth/ensure-token";
import { buildAuthorizationUrl, type OAuthProviderConfig } from "../oauth/wrapper";

/** kv namespace for the Linear bot's appUserId (Q21.C). Keyed by workspace ID. */
const APP_USER_ID_NAMESPACE = "integration:linear:bot-app-user-id";

/**
 * Thin projection of the seeded `oauth_apps` row. The comma `scopeSeparator`
 * quirk and `actor` extra-param are seeded as column/metadata by `initLinear()`
 * and surfaced by {@link oauthAppRowToProviderConfig}.
 */
export function getLinearOAuthConfig(): OAuthProviderConfig | null {
  const app = getOAuthApp("linear");
  return app ? oauthAppRowToProviderConfig(app) : null;
}

export async function getLinearAuthorizationUrl(): Promise<string | null> {
  const config = getLinearOAuthConfig();
  if (!config) return null;
  // flow='tracker' so the unified state-keyed callback runs the tracker
  // post-processing (appUserId capture) after landing tokens on the default
  // authorization.
  const result = await buildAuthorizationUrl(config, { flow: "tracker", label: "default" });
  return result.url;
}

/**
 * Query Linear's GraphQL `viewer` to find the OAuth-actor's user id and
 * organization id, then persist it under `integration:linear:bot-app-user-id`.
 *
 * NOTE: when the OAuth app is installed with `actor=app`, Linear's `viewer`
 * resolves to the synthetic app-user — the "bot identity" that emits
 * AgentSessionEvent.created with `agentSession.creator.id === viewer.id`. That
 * is precisely the value Q21.C asks us to compare against.
 */
export async function captureLinearAppUserId(accessToken: string): Promise<void> {
  const query = `query { viewer { id organization { id } } }`;
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`Linear viewer query failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    data?: { viewer?: { id?: string; organization?: { id?: string } } };
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(`Linear viewer query returned errors: ${body.errors[0]?.message ?? "?"}`);
  }
  const appUserId = body.data?.viewer?.id;
  const workspaceId = body.data?.viewer?.organization?.id;
  if (!appUserId) {
    throw new Error("Linear viewer query returned no id");
  }
  upsertKv({
    namespace: APP_USER_ID_NAMESPACE,
    key: workspaceId && workspaceId !== "" ? workspaceId : "default",
    value: appUserId,
    valueType: "string",
    expiresAt: null,
  });
}

/**
 * Revoke an OAuth access token with Linear. Best-effort — caller should not
 * abort the disconnect flow if this fails. Linear's revocation endpoint is
 * `POST https://api.linear.app/oauth/revoke` with the access token in the
 * Authorization header (per https://developers.linear.app/docs/oauth/authentication).
 *
 * Returns true on a 2xx response, false otherwise.
 */
export async function revokeLinearToken(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.linear.app/oauth/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok;
  } catch (err) {
    console.warn(
      "[Linear] Token revocation failed (best-effort):",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
