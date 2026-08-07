import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  deleteOAuthTokens,
  getAuthorizationById,
  getDefaultAuthorizationIdForProvider,
  getOAuthTokens,
} from "../../be/db-queries/oauth";
import { isLinearEnabled } from "../../linear/app";
import { getLinearAuthorizationUrl, revokeLinearToken } from "../../linear/oauth";
import { handleLinearWebhook } from "../../linear/webhook";
import { forceRefreshAuthorizationOrThrow } from "../../oauth/ensure-token";
import { completeGenericOAuthCallback } from "../oauth-callback";
import { route } from "../route-def";
import { deriveApiBaseUrl, parseQueryParams } from "../utils";

// ─── Schemas ─────────────────────────────────────────────────────────────────

/** Shape returned by `buildLinearStatusPayload` — shared by /status and /refresh. */
const LinearStatusSchema = z.object({
  provider: z.literal("linear"),
  connected: z.boolean(),
  tokenExpiry: z.string().nullable(),
  scope: z.string().nullable(),
  webhookUrl: z.string(),
  redirectUri: z.string(),
});

/** The two `body` shapes `handleLinearWebhook` (../../linear/webhook.ts) sends for its 200 code. */
const LinearWebhookAcceptedSchema = z.object({
  status: z.enum(["duplicate", "accepted"]),
});

const LinearDisconnectSchema = z.object({
  disconnected: z.literal(true),
  revoked: z.boolean(),
});

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
    200: {
      description: "OAuth complete",
      unstructured:
        "HTML success page (sendAuthorizedHtml) sent by completeGenericOAuthCallback in ../oauth-callback.ts — shape not owned by this file",
    },
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
    200: { description: "Connection status", schema: LinearStatusSchema },
    503: { description: "Linear integration not configured" },
  },
});

const linearRefresh = route({
  method: "post",
  path: "/api/trackers/linear/refresh",
  pattern: ["api", "trackers", "linear", "refresh"],
  summary:
    "Force a Linear OAuth token refresh and return the updated status payload. Useful when an agent observes an expired token and wants to recover without restarting the server or re-running OAuth.",
  tags: ["Trackers"],
  responses: {
    200: {
      description: "Token refreshed; returns same shape as /status",
      schema: LinearStatusSchema,
    },
    409: { description: "Linear not connected (no refresh token stored)" },
    500: { description: "Refresh failed" },
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
    200: { description: "Event accepted", schema: LinearWebhookAcceptedSchema },
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
    200: { description: "Disconnected", schema: LinearDisconnectSchema },
    503: { description: "Linear not configured" },
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildLinearStatusPayload(req: IncomingMessage): z.infer<typeof LinearStatusSchema> {
  const tokens = getOAuthTokens("linear");
  const baseUrl = deriveApiBaseUrl(req);

  return {
    provider: "linear",
    connected: !!tokens,
    tokenExpiry: tokens?.expiresAt ?? null,
    scope: tokens?.scope ?? null,
    webhookUrl: `${baseUrl}/api/trackers/linear/webhook`,
    redirectUri: `${baseUrl}/api/trackers/linear/callback`,
  };
}

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

    // Delegate to the unified, state-keyed callback. The redirect URI still
    // points here (registered with Linear), so this route stays valid; it now
    // consumes the DB-backed pending row, lands tokens on the default
    // authorization, and runs the tracker post-processing (appUserId capture).
    const { handled } = await completeGenericOAuthCallback(res, parsed.query);
    if (!handled) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or expired OAuth state" }));
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

    linearStatus.respond(res, 200, buildLinearStatusPayload(req));
    return true;
  }

  // POST /api/trackers/linear/refresh — force-refresh the Linear access token.
  // Mirrors the Jira refresh route; recovery path for agents that observe a
  // stale token in oauth_tokens.
  if (linearRefresh.match(req.method, pathSegments)) {
    if (!isLinearEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Linear integration not configured" }));
      return true;
    }

    const authorizationId = getDefaultAuthorizationIdForProvider("linear");
    const authorization = authorizationId ? getAuthorizationById(authorizationId) : null;
    if (!authorization?.refreshToken) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Linear not connected — no refresh token stored. Run OAuth via /authorize.",
        }),
      );
      return true;
    }

    try {
      await forceRefreshAuthorizationOrThrow(authorizationId as string);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Linear] Forced token refresh failed:", message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Token refresh failed", details: message }));
      return true;
    }

    linearRefresh.respond(res, 200, buildLinearStatusPayload(req));
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
    // handleLinearWebhook's return type is `{ status: number; body: unknown }` (it
    // can send 503/401/200 — all declared on this route); narrow to the literal
    // 200 code to use the typed egress for the one 2xx case, keep the raw
    // passthrough (same status/body/header as before) for 401/503.
    if (result.status === 200) {
      linearWebhook.respond(res, 200, result.body as z.infer<typeof LinearWebhookAcceptedSchema>);
      return true;
    }
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

    linearDisconnect.respond(res, 200, { disconnected: true, revoked });
    return true;
  }

  return false;
}
