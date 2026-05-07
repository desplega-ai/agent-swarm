import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { deleteOAuthTokens, getOAuthTokens } from "../../be/db-queries/oauth";
import { isNotionEnabled } from "../../notion/app";
import { clearNotionMetadata, getNotionMetadata } from "../../notion/metadata";
import {
  getNotionAuthorizationUrl,
  handleNotionCallback,
  revokeNotionToken,
} from "../../notion/oauth";
import { ensureTokenOrThrow } from "../../oauth/ensure-token";
import { route } from "../route-def";
import { deriveApiBaseUrl, parseQueryParams } from "../utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const notionAuthorize = route({
  method: "get",
  path: "/api/trackers/notion/authorize",
  pattern: ["api", "trackers", "notion", "authorize"],
  summary: "Redirect to Notion OAuth consent screen",
  tags: ["Trackers"],
  auth: { apiKey: false },
  responses: {
    302: { description: "Redirect to Notion OAuth" },
    500: { description: "Failed to generate authorization URL" },
    503: { description: "Notion integration not configured" },
  },
});

const notionCallback = route({
  method: "get",
  path: "/api/trackers/notion/callback",
  pattern: ["api", "trackers", "notion", "callback"],
  summary: "Handle Notion OAuth callback",
  tags: ["Trackers"],
  auth: { apiKey: false },
  query: z.object({
    code: z.string(),
    state: z.string(),
  }),
  responses: {
    200: { description: "OAuth complete" },
    400: { description: "Invalid state or code" },
    500: { description: "Token exchange failed" },
  },
});

const notionStatus = route({
  method: "get",
  path: "/api/trackers/notion/status",
  pattern: ["api", "trackers", "notion", "status"],
  summary: "Notion connection status, token expiry, workspace info",
  tags: ["Trackers"],
  responses: {
    200: { description: "Connection status" },
    503: { description: "Notion integration not configured" },
  },
});

const notionRefresh = route({
  method: "post",
  path: "/api/trackers/notion/refresh",
  pattern: ["api", "trackers", "notion", "refresh"],
  summary:
    "Force a Notion OAuth token refresh and return the updated status payload. Useful when an agent observes an expired token and wants to recover without restarting the server or re-running OAuth.",
  tags: ["Trackers"],
  responses: {
    200: { description: "Token refreshed; returns same shape as /status" },
    409: { description: "Notion not connected (no refresh token stored)" },
    500: { description: "Refresh failed" },
    503: { description: "Notion integration not configured" },
  },
});

const notionDisconnect = route({
  method: "delete",
  path: "/api/trackers/notion/disconnect",
  pattern: ["api", "trackers", "notion", "disconnect"],
  summary: "Fully disconnect Notion: revoke OAuth grant + drop tokens + clear metadata",
  tags: ["Trackers"],
  responses: {
    200: { description: "Disconnected" },
    503: { description: "Notion not configured" },
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildNotionStatusPayload(req: IncomingMessage): Record<string, unknown> {
  const tokens = getOAuthTokens("notion");
  const metadata = getNotionMetadata();
  const baseUrl = deriveApiBaseUrl(req);

  return {
    provider: "notion",
    connected: !!tokens,
    tokenExpiry: tokens?.expiresAt ?? null,
    scope: tokens?.scope ?? null,
    workspaceId: metadata.workspaceId ?? null,
    workspaceName: metadata.workspaceName ?? null,
    workspaceIcon: metadata.workspaceIcon ?? null,
    botId: metadata.botId ?? null,
    redirectUri: `${baseUrl}/api/trackers/notion/callback`,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleNotionTracker(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  // GET /api/trackers/notion/authorize — redirect to Notion OAuth
  if (notionAuthorize.match(req.method, pathSegments)) {
    if (!isNotionEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Notion integration not configured" }));
      return true;
    }

    try {
      const url = await getNotionAuthorizationUrl();
      if (!url) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to generate authorization URL" }));
        return true;
      }

      res.writeHead(302, { Location: url });
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Notion] Failed to generate authorization URL:", message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to generate authorization URL" }));
    }
    return true;
  }

  // GET /api/trackers/notion/callback — handle OAuth callback
  if (notionCallback.match(req.method, pathSegments)) {
    const queryParams = parseQueryParams(req.url || "");
    const parsed = await notionCallback.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true; // parse() already sent 400

    const { code, state } = parsed.query;

    try {
      await handleNotionCallback(code, state);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Notion Connected</title></head>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
  <div style="text-align: center;">
    <h1>Notion Connected</h1>
    <p>OAuth authorization complete. You can close this window.</p>
  </div>
</body>
</html>`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Notion] OAuth callback failed:", message);

      if (message.includes("Invalid or expired OAuth state")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or expired OAuth state" }));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Token exchange failed", details: message }));
      }
    }
    return true;
  }

  // GET /api/trackers/notion/status — connection status
  if (notionStatus.match(req.method, pathSegments)) {
    if (!isNotionEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Notion integration not configured" }));
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildNotionStatusPayload(req)));
    return true;
  }

  // POST /api/trackers/notion/refresh — force-refresh the access token.
  if (notionRefresh.match(req.method, pathSegments)) {
    if (!isNotionEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Notion integration not configured" }));
      return true;
    }

    const tokens = getOAuthTokens("notion");
    if (!tokens?.refreshToken) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Notion not connected — no refresh token stored. Run OAuth via /authorize.",
        }),
      );
      return true;
    }

    try {
      await ensureTokenOrThrow("notion", Number.MAX_SAFE_INTEGER);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Notion] Forced token refresh failed:", message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Token refresh failed", details: message }));
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildNotionStatusPayload(req)));
    return true;
  }

  // DELETE /api/trackers/notion/disconnect — full cleanup.
  if (notionDisconnect.match(req.method, pathSegments)) {
    if (!isNotionEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Notion not configured" }));
      return true;
    }

    const tokens = getOAuthTokens("notion");
    let revoked = false;
    if (tokens?.accessToken) {
      revoked = await revokeNotionToken(tokens.accessToken);
    }

    deleteOAuthTokens("notion");
    clearNotionMetadata();

    console.log(`[Notion] Disconnected: revoke=${revoked}, tokens cleared`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ disconnected: true, revoked }));
    return true;
  }

  return false;
}
