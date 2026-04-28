import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { deleteOAuthTokens, getOAuthTokens } from "../../be/db-queries/oauth";
import { isLinearEnabled } from "../../linear/app";
import {
  getLinearAuthorizationUrl,
  handleLinearCallback,
  revokeLinearToken,
} from "../../linear/oauth";
import { handleLinearWebhook } from "../../linear/webhook";
import { route } from "../route-def";
import { deriveApiBaseUrl, parseQueryParams } from "../utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const linearAuthorize = route({
  method: "get",
  path: "/api/trackers/linear/authorize",
  pattern: ["api", "trackers", "linear", "authorize"],
  summary: "Redirect to Linear OAuth consent screen",
  tags: ["Trackers"],
  auth: { apiKey: false },
  responses: {
    302: { description: "Redirect to Linear OAuth" },
    500: { description: "Failed to generate authorization URL" },
    503: { description: "Linear integration not configured" },
  },
});

const linearCallback = route({
  method: "get",
  path: "/api/trackers/linear/callback",
  pattern: ["api", "trackers", "linear", "callback"],
  summary: "Handle Linear OAuth callback",
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

const linearStatus = route({
  method: "get",
  path: "/api/trackers/linear/status",
  pattern: ["api", "trackers", "linear", "status"],
  summary: "Linear connection status, token expiry, workspace info, expected webhook URL",
  tags: ["Trackers"],
  responses: {
    200: { description: "Connection status" },
    503: { description: "Linear integration not configured" },
  },
});

const linearWebhook = route({
  method: "post",
  path: "/api/trackers/linear/webhook",
  pattern: ["api", "trackers", "linear", "webhook"],
  summary: "Handle Linear webhook events (signature-verified)",
  tags: ["Trackers"],
  auth: { apiKey: false },
  responses: {
    200: { description: "Event accepted" },
    401: { description: "Invalid signature" },
    503: { description: "Linear integration not configured" },
  },
});

// Admin: full disconnect — best-effort revoke the OAuth grant with Linear,
// then drop stored tokens. Linear webhooks are configured globally on the
// OAuth app (not per-tenant), so no per-tenant webhook delete is needed.
const linearDisconnect = route({
  method: "delete",
  path: "/api/trackers/linear/disconnect",
  pattern: ["api", "trackers", "linear", "disconnect"],
  summary: "Fully disconnect Linear: revoke OAuth grant + drop tokens",
  tags: ["Trackers"],
  responses: {
    200: { description: "Disconnected" },
    503: { description: "Linear not configured" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleLinearTracker(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  // GET /api/trackers/linear/authorize — redirect to Linear OAuth
  if (linearAuthorize.match(req.method, pathSegments)) {
    if (!isLinearEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Linear integration not configured" }));
      return true;
    }

    try {
      const url = await getLinearAuthorizationUrl();
      if (!url) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to generate authorization URL" }));
        return true;
      }

      res.writeHead(302, { Location: url });
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Linear] Failed to generate authorization URL:", message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to generate authorization URL" }));
    }
    return true;
  }

  // GET /api/trackers/linear/callback — handle OAuth callback from Linear
  if (linearCallback.match(req.method, pathSegments)) {
    const queryParams = parseQueryParams(req.url || "");
    const parsed = await linearCallback.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true; // parse() already sent 400

    const { code, state } = parsed.query;

    try {
      await handleLinearCallback(code, state);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Linear Connected</title></head>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
  <div style="text-align: center;">
    <h1>Linear Connected</h1>
    <p>OAuth authorization complete. You can close this window.</p>
  </div>
</body>
</html>`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Linear] OAuth callback failed:", message);

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

  // GET /api/trackers/linear/status — connection status
  if (linearStatus.match(req.method, pathSegments)) {
    if (!isLinearEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Linear integration not configured" }));
      return true;
    }

    const tokens = getOAuthTokens("linear");
    const baseUrl = deriveApiBaseUrl(req);

    const status = {
      provider: "linear",
      connected: !!tokens,
      tokenExpiry: tokens?.expiresAt ?? null,
      scope: tokens?.scope ?? null,
      webhookUrl: `${baseUrl}/api/trackers/linear/webhook`,
      redirectUri: `${baseUrl}/api/trackers/linear/callback`,
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return true;
  }

  // POST /api/trackers/linear/webhook — handle Linear webhook events
  if (linearWebhook.match(req.method, pathSegments)) {
    // Read raw body for HMAC signature verification (same pattern as GitHub/GitLab webhooks)
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString();

    // Collect headers into a plain object for the webhook handler
    const headers: Record<string, string | undefined> = {
      "linear-signature": req.headers["linear-signature"] as string | undefined,
      "x-linear-signature": req.headers["x-linear-signature"] as string | undefined,
      "linear-delivery": req.headers["linear-delivery"] as string | undefined,
    };

    const result = await handleLinearWebhook(rawBody, headers);
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
    return true;
  }

  // DELETE /api/trackers/linear/disconnect — full cleanup.
  if (linearDisconnect.match(req.method, pathSegments)) {
    if (!isLinearEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Linear integration not configured" }));
      return true;
    }

    const tokens = getOAuthTokens("linear");
    let revoked = false;
    if (tokens?.accessToken) {
      revoked = await revokeLinearToken(tokens.accessToken);
    }

    deleteOAuthTokens("linear");

    console.log(`[Linear] Disconnected: revoke=${revoked}, tokens cleared`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ disconnected: true, revoked }));
    return true;
  }

  return false;
}
