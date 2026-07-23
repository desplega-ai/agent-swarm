import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { gcMcpOAuthPending } from "@/be/db-queries/mcp-oauth";
import {
  consumeOAuthPending,
  gcOAuthPending,
  getOAuthAppById,
  updateAuthorizationIdentity,
  upsertAuthorization,
} from "@/be/db-queries/oauth";
import { oauthAppRowToProviderConfig } from "@/oauth/ensure-token";
import { captureIdentity } from "@/oauth/identity-capture";
import { exchangeAuthorizationCode } from "@/oauth/wrapper";
import { getPublicMcpBaseUrl } from "@/utils/constants";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { completeMcpOAuthCallback } from "./mcp-oauth";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── The single static callback + redirect-uri display ───────────────────────

/** The constant, state-keyed OAuth redirect target for all flows. */
export function staticOAuthCallbackUri(): string {
  return `${getPublicMcpBaseUrl()}/api/oauth/callback`;
}

const callbackRoute = route({
  method: "get",
  path: "/api/oauth/callback",
  pattern: ["api", "oauth", "callback"],
  operationId: "oauth_static_callback",
  summary: "Single static OAuth redirect target (state-keyed, all flows)",
  tags: ["OAuth"],
  auth: { apiKey: false },
  query: z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  }),
  responses: {
    200: { description: "OAuth authorization completed" },
    302: { description: "Redirect back to the final destination" },
    400: { description: "Missing or invalid OAuth callback parameters" },
    404: { description: "OAuth app not configured" },
    502: { description: "Token exchange failed" },
  },
});

const redirectUriRoute = route({
  method: "get",
  path: "/api/oauth/redirect-uri",
  pattern: ["api", "oauth", "redirect-uri"],
  operationId: "oauth_redirect_uri",
  summary: "The static OAuth callback URL to register with providers (pre-creation display)",
  tags: ["OAuth"],
  responses: {
    200: { description: "{ redirectUri: string }" },
  },
});

interface OAuthCallbackParams {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

function sendAuthorizedHtml(res: ServerResponse, provider: string, label: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html>
<html>
<head><title>OAuth Authorized</title></head>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
  <main style="text-align: center;">
    <h1>${provider} authorized</h1>
    <p>Connected the "${label}" authorization. You can close this tab.</p>
  </main>
</body>
</html>`);
}

function redirectWith(res: ServerResponse, base: string, params: Record<string, string>): void {
  const target = new URL(base);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  res.writeHead(302, { Location: target.toString() });
  res.end();
}

/**
 * Complete a generic/tracker OAuth callback: consume the pending row, exchange
 * the code against the app's token endpoint, upsert the `(appId, label)`
 * authorization, and capture account identity (best-effort). Returns
 * `{ handled: false }` (without writing a response) when no generic/tracker
 * pending row matches `state`, so callers can fall through to the MCP flow.
 */
export async function completeGenericOAuthCallback(
  res: ServerResponse,
  query: OAuthCallbackParams,
): Promise<{ handled: boolean }> {
  const state = query.state;
  if (!state) return { handled: false };

  const pending = consumeOAuthPending(state);
  if (!pending) return { handled: false };

  const app = getOAuthAppById(pending.appId);
  if (!app) {
    if (pending.finalRedirect) {
      redirectWith(res, pending.finalRedirect, { oauth: "error", error: "app_not_found" });
    } else {
      jsonError(res, "OAuth app is no longer configured", 404);
    }
    return { handled: true };
  }

  if (query.error) {
    const description = query.error_description ?? query.error;
    if (pending.finalRedirect) {
      redirectWith(res, pending.finalRedirect, {
        oauth: "error",
        error: query.error,
        error_description: description,
      });
    } else {
      jsonError(res, description, 400);
    }
    return { handled: true };
  }

  if (!query.code) {
    if (pending.finalRedirect) {
      redirectWith(res, pending.finalRedirect, { oauth: "error", error: "missing_code" });
    } else {
      jsonError(res, "Missing authorization code", 400);
    }
    return { handled: true };
  }

  try {
    const config = oauthAppRowToProviderConfig(app);
    const tokens = await exchangeAuthorizationCode(config, {
      code: query.code,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
    });
    const expiresAt = tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const authorization = upsertAuthorization({
      appId: pending.appId,
      label: pending.label,
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken != null ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
      expiresAt,
      ...(tokens.scope != null ? { scope: tokens.scope } : {}),
      ...(pending.userId ? { userId: pending.userId, connectedByUserId: pending.userId } : {}),
      status: "active",
    });

    const identity = await captureIdentity({
      userinfoUrl: app.userinfoUrl,
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
    });
    if (identity) {
      updateAuthorizationIdentity(authorization.id, {
        accountEmail: identity.accountEmail,
        identityJson: identity.identityJson,
      });
    }

    if (pending.finalRedirect) {
      redirectWith(res, pending.finalRedirect, { oauth: "success" });
    } else {
      sendAuthorizedHtml(res, app.provider, pending.label);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(scrubSecrets(`[oauth] callback exchange failed for ${app.provider}: ${message}`));
    if (pending.finalRedirect) {
      redirectWith(res, pending.finalRedirect, { oauth: "error", error_description: message });
    } else {
      jsonError(res, `Token exchange failed: ${message}`, 502);
    }
  }
  return { handled: true };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (redirectUriRoute.match(req.method, pathSegments)) {
    json(res, { redirectUri: staticOAuthCallbackUri() });
    return true;
  }

  if (!callbackRoute.match(req.method, pathSegments)) return false;

  const parsed = await callbackRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;

  if (!parsed.query.state) {
    jsonError(res, "Missing state parameter", 400);
    return true;
  }

  const generic = await completeGenericOAuthCallback(res, parsed.query);
  if (generic.handled) return true;

  // Not a generic/tracker pending — try the MCP flow (same static callback).
  const mcpHandled = await completeMcpOAuthCallback(res, parsed.query);
  if (!mcpHandled) {
    jsonError(res, "Invalid or expired OAuth state", 400);
  }
  return true;
}

// ─── Unified pending garbage collector (all flows) ───────────────────────────

let gcTimer: ReturnType<typeof setInterval> | null = null;

export function startOAuthPendingGc(intervalMs = 5 * 60 * 1000): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    try {
      const removed = gcOAuthPending() + gcMcpOAuthPending();
      if (removed > 0) {
        console.debug(`[oauth] GC removed ${removed} expired pending session(s)`);
      }
    } catch (err) {
      console.error("[oauth] pending GC failed:", err);
    }
  }, intervalMs);
  if (typeof gcTimer?.unref === "function") gcTimer.unref();
}

export function stopOAuthPendingGc(): void {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
}
