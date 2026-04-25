import {
  applyMcpOAuthRefresh,
  getMcpOAuthToken,
  isMcpTokenExpiringSoon,
  type McpOAuthToken,
  markMcpOAuthTokenStatus,
} from "../be/db-queries/mcp-oauth";
import { computeExpiresAt, refreshMcpToken } from "./mcp-wrapper";

/**
 * Per-mcpServerId in-memory mutex to serialize concurrent refreshes.
 * Avoids the double-refresh race when two requests hit resolveSecrets at the
 * same time — the second waits for the first's result.
 */
const inflight = new Map<string, Promise<McpOAuthToken | null>>();

interface EnsureOptions {
  /**
   * How far ahead to treat a token as expiring. Default 5 minutes for
   * reactive callers; the keepalive path should pass a larger value.
   */
  bufferMs?: number;
  userId?: string | null;
}

/**
 * Return a valid, non-expired token for the given MCP server, refreshing if
 * needed. Returns `null` when no token row exists for the (mcpServerId, userId)
 * pair or when refresh permanently fails (status flipped to 'error').
 */
export async function ensureMcpToken(
  mcpServerId: string,
  opts: EnsureOptions = {},
): Promise<McpOAuthToken | null> {
  const userId = opts.userId ?? null;
  const key = `${mcpServerId}::${userId ?? "_"}`;

  const existing = inflight.get(key);
  if (existing) return existing;

  const work = (async () => {
    const token = getMcpOAuthToken(mcpServerId, userId);
    if (!token) return null;
    if (token.status === "revoked") return token;
    if (!isMcpTokenExpiringSoon(token, opts.bufferMs)) return token;
    if (!token.refreshToken) {
      markMcpOAuthTokenStatus(
        token.id,
        "expired",
        "No refresh token available; reconnect required.",
      );
      return { ...token, status: "expired" as const };
    }

    try {
      const refreshed = await refreshMcpToken({
        tokenUrl: token.tokenUrl,
        clientId: token.dcrClientId ?? "",
        clientSecret: token.dcrClientSecret ?? undefined,
        refreshToken: token.refreshToken,
        resource: token.resourceUrl,
        scopes: token.scope ? token.scope.split(" ").filter(Boolean) : undefined,
      });

      applyMcpOAuthRefresh(token.id, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? undefined,
        expiresAt: computeExpiresAt(refreshed.expires_in),
        scope: refreshed.scope ?? null,
      });

      return getMcpOAuthToken(mcpServerId, userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markMcpOAuthTokenStatus(token.id, "error", message);
      console.error(`[mcp-oauth] refresh failed for ${mcpServerId}: ${message}`);
      return { ...token, status: "error" as const, lastErrorMessage: message };
    }
  })();

  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}
