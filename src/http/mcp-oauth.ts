import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getMcpServerById } from "../be/db";
import type { McpOAuthToken } from "../be/db-queries/mcp-oauth";
import {
  applyMcpOAuthRefresh,
  consumeMcpOAuthPending,
  deleteMcpOAuthToken,
  getMcpOAuthToken,
  insertMcpOAuthPending,
  setMcpServerAuthMethod,
  upsertMcpOAuthToken,
} from "../be/db-queries/mcp-oauth";
import { ensureMcpToken } from "../oauth/ensure-mcp-token";
import {
  assertUrlSafe,
  buildAuthorizeUrl,
  computeExpiresAt,
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  exchangeCodeForTokens,
  refreshMcpToken,
  registerClient,
  revokeMcpToken,
} from "../oauth/mcp-wrapper";
import { getAppUrl, getPublicMcpBaseUrl } from "../utils/constants";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ssrfOptions() {
  return {
    allowPrivateHosts: process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS === "true",
    allowInsecure: process.env.NODE_ENV !== "production",
  };
}

function callbackRedirectUri(): string {
  // The callback route lives on the API server, so it must use the PUBLIC MCP
  // base (externally reachable), not the dashboard APP_URL.
  return `${getPublicMcpBaseUrl()}/api/mcp-oauth/callback`;
}

function dashboardBase(): string {
  // getAppUrl absorbs DASHBOARD_URL as a deprecated alias.
  return getAppUrl();
}

function defaultFinalRedirect(mcpServerId: string): string {
  return `${dashboardBase()}/mcp-servers/${mcpServerId}?oauth=success`;
}

interface DiscoveryResult {
  resourceUrl: string;
  authorizationServerIssuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  registrationEndpoint: string | null;
  scopes: string[];
  requiresOAuth: boolean;
  dcrSupported: boolean;
  bearerMethodsSupported: string[] | null;
}

interface OAuthClientForAuthorize {
  clientId: string;
  clientSecret: string | null;
  resourceUrl: string;
  authorizationServerIssuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  scopes: string[];
}

function splitScopes(scopes: string | null | undefined): string[] {
  return scopes?.split(/\s+/).filter(Boolean) ?? [];
}

function manualClientFromToken(token: McpOAuthToken | null): OAuthClientForAuthorize | null {
  if (!token || token.clientSource !== "manual" || !token.dcrClientId) return null;

  // The manual-client route validates these on write. Re-check before using the
  // stored endpoints because /authorize redirects the browser to authorizeUrl.
  assertUrlSafe(token.resourceUrl, ssrfOptions());
  assertUrlSafe(token.authorizeUrl, ssrfOptions());
  assertUrlSafe(token.tokenUrl, ssrfOptions());
  if (token.revocationUrl) assertUrlSafe(token.revocationUrl, ssrfOptions());

  return {
    clientId: token.dcrClientId,
    clientSecret: token.dcrClientSecret,
    resourceUrl: token.resourceUrl,
    authorizationServerIssuer: token.authorizationServerIssuer,
    authorizeUrl: token.authorizeUrl,
    tokenUrl: token.tokenUrl,
    revocationUrl: token.revocationUrl,
    scopes: splitScopes(token.scope),
  };
}

async function discoverForMcp(resourceUrl: string): Promise<DiscoveryResult | null> {
  assertUrlSafe(resourceUrl, ssrfOptions());

  const prmd = await discoverProtectedResourceMetadata(resourceUrl);
  if (!prmd) return null;

  const issuer = prmd.authorization_servers?.[0];
  if (!issuer) return null;

  const as = await discoverAuthorizationServerMetadata(issuer);

  return {
    resourceUrl: prmd.resource ?? resourceUrl,
    authorizationServerIssuer: as.issuer,
    authorizeUrl: as.authorization_endpoint,
    tokenUrl: as.token_endpoint,
    revocationUrl: as.revocation_endpoint ?? null,
    registrationEndpoint: as.registration_endpoint ?? null,
    scopes: prmd.scopes_supported ?? as.scopes_supported ?? [],
    requiresOAuth: true,
    dcrSupported: !!as.registration_endpoint,
    bearerMethodsSupported: prmd.bearer_methods_supported ?? null,
  };
}

function getMcpOrError(
  res: ServerResponse,
  mcpServerId: string,
): ReturnType<typeof getMcpServerById> | null {
  const server = getMcpServerById(mcpServerId);
  if (!server) {
    jsonError(res, "MCP server not found", 404);
    return null;
  }
  if (server.transport === "stdio") {
    jsonError(res, "OAuth is only supported for http/sse transports", 400);
    return null;
  }
  if (!server.url) {
    jsonError(res, "MCP server has no URL", 400);
    return null;
  }
  return server;
}

// ─── Route definitions ───────────────────────────────────────────────────────

const metadataRoute = route({
  method: "get",
  path: "/api/mcp-oauth/{mcpServerId}/metadata",
  pattern: ["api", "mcp-oauth", null, "metadata"],
  summary: "Probe OAuth metadata (PRMD + AS) for an MCP server",
  tags: ["MCP OAuth"],
  auth: { apiKey: true },
  params: z.object({ mcpServerId: z.string() }),
  responses: {
    200: { description: "OAuth metadata or { requiresOAuth: false }" },
    400: { description: "MCP has no URL / invalid transport" },
    404: { description: "MCP server not found" },
  },
});

const statusRoute = route({
  method: "get",
  path: "/api/mcp-oauth/{mcpServerId}/status",
  pattern: ["api", "mcp-oauth", null, "status"],
  summary: "Get the current OAuth connection status for an MCP server",
  tags: ["MCP OAuth"],
  auth: { apiKey: true },
  params: z.object({ mcpServerId: z.string() }),
  query: z.object({ userId: z.string().optional() }),
  responses: {
    200: { description: "Token status (never includes the token value itself)" },
    404: { description: "MCP server not found" },
  },
});

const authorizeRoute = route({
  method: "get",
  path: "/api/mcp-oauth/{mcpServerId}/authorize",
  pattern: ["api", "mcp-oauth", null, "authorize"],
  summary: "Start an OAuth flow. Redirects to the provider.",
  tags: ["MCP OAuth"],
  auth: { apiKey: true },
  params: z.object({ mcpServerId: z.string() }),
  query: z.object({
    redirect: z.string().optional(),
    userId: z.string().optional(),
    scopes: z.string().optional(),
  }),
  rbac: { permission: "mcp-oauth.authorize.any" },
  responses: {
    302: { description: "Redirect to authorization server" },
    400: { description: "MCP has no URL / does not require OAuth" },
    404: { description: "MCP server not found" },
  },
});

const authorizeUrlRoute = route({
  method: "get",
  path: "/api/mcp-oauth/{mcpServerId}/authorize-url",
  pattern: ["api", "mcp-oauth", null, "authorize-url"],
  summary:
    "Build an OAuth authorize URL. Returns JSON so the browser can navigate without losing the Bearer auth header.",
  tags: ["MCP OAuth"],
  auth: { apiKey: true },
  params: z.object({ mcpServerId: z.string() }),
  query: z.object({
    redirect: z.string().optional(),
    userId: z.string().optional(),
    scopes: z.string().optional(),
  }),
  rbac: { permission: "mcp-oauth.authorize.any" },
  responses: {
    200: { description: "{ providerUrl: string }" },
    400: { description: "MCP has no URL / does not require OAuth" },
    404: { description: "MCP server not found" },
  },
});

const callbackRoute = route({
  method: "get",
  path: "/api/mcp-oauth/callback",
  pattern: ["api", "mcp-oauth", "callback"],
  summary: "OAuth redirect target. Exchanges code -> tokens and redirects back to dashboard.",
  tags: ["MCP OAuth"],
  auth: { apiKey: false },
  query: z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  }),
  responses: {
    302: { description: "Redirect back to dashboard with oauth=success or oauth=error" },
    400: { description: "Bad state / missing code" },
  },
});

const refreshRoute = route({
  method: "post",
  path: "/api/mcp-oauth/{mcpServerId}/refresh",
  pattern: ["api", "mcp-oauth", null, "refresh"],
  summary: "Force-refresh the access token for an MCP server",
  tags: ["MCP OAuth"],
  auth: { apiKey: true },
  params: z.object({ mcpServerId: z.string() }),
  body: z
    .object({
      userId: z.string().optional(),
    })
    .optional(),
  responses: {
    200: { description: "Refreshed token" },
    404: { description: "No token for this MCP server" },
    500: { description: "Refresh failed" },
  },
});

const disconnectRoute = route({
  method: "delete",
  path: "/api/mcp-oauth/{mcpServerId}",
  pattern: ["api", "mcp-oauth", null],
  summary: "Revoke and delete the OAuth token for an MCP server",
  tags: ["MCP OAuth"],
  auth: { apiKey: true },
  params: z.object({ mcpServerId: z.string() }),
  query: z.object({ userId: z.string().optional() }),
  responses: {
    200: { description: "Token revoked/deleted" },
    404: { description: "No token for this MCP server" },
  },
});

const manualClientRoute = route({
  method: "post",
  path: "/api/mcp-oauth/{mcpServerId}/manual-client",
  pattern: ["api", "mcp-oauth", null, "manual-client"],
  summary: "Register a pre-existing OAuth client (DCR fallback)",
  tags: ["MCP OAuth"],
  auth: { apiKey: true },
  params: z.object({ mcpServerId: z.string() }),
  body: z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().optional(),
    authorizationServerIssuer: z.string().url().optional(),
    authorizeUrl: z.string().url().optional(),
    tokenUrl: z.string().url().optional(),
    revocationUrl: z.string().url().optional(),
    scopes: z.array(z.string()).optional(),
  }),
  responses: {
    200: { description: "Pending client stored. Call /authorize to start the flow." },
    400: { description: "Bad input" },
    404: { description: "MCP server not found" },
  },
});

// ─── Shared authorize flow ───────────────────────────────────────────────────

interface AuthorizeFlowQuery {
  redirect?: string;
  userId?: string;
  scopes?: string;
}

/**
 * Use a stored manual client or discover metadata + DCR-register, build the
 * authorize URL, and persist the pending session. Returns the provider
 * `providerUrl` the caller should redirect to / respond with. On failure,
 * writes a JSON error response and returns null.
 */
async function prepareAuthorizeFlow(
  res: ServerResponse,
  mcpServerId: string,
  server: NonNullable<ReturnType<typeof getMcpServerById>>,
  q: AuthorizeFlowQuery,
): Promise<string | null> {
  const userId = q.userId ?? null;
  let client = manualClientFromToken(getMcpOAuthToken(mcpServerId, userId));

  if (!client) {
    const discovery = await discoverForMcp(server.url!);
    if (!discovery) {
      jsonError(res, "MCP server does not require OAuth", 400);
      return null;
    }

    if (!discovery.dcrSupported || !discovery.registrationEndpoint) {
      jsonError(
        res,
        "DCR not supported — paste client_id/client_secret via POST /api/mcp-oauth/:id/manual-client first.",
        400,
      );
      return null;
    }

    const scopes = q.scopes ? splitScopes(q.scopes) : discovery.scopes;
    const dcr = await registerClient(discovery.registrationEndpoint, {
      client_name: `agent-swarm (${server.name})`,
      redirect_uris: [callbackRedirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      application_type: "web",
      scope: scopes.join(" ") || undefined,
    });

    client = {
      clientId: dcr.client_id,
      clientSecret: dcr.client_secret ?? null,
      resourceUrl: discovery.resourceUrl,
      authorizationServerIssuer: discovery.authorizationServerIssuer,
      authorizeUrl: discovery.authorizeUrl,
      tokenUrl: discovery.tokenUrl,
      revocationUrl: discovery.revocationUrl,
      scopes,
    };
  }

  const scopes = q.scopes ? splitScopes(q.scopes) : client.scopes;

  let extraParams: Record<string, string> | undefined;
  if (server.extraAuthorizeParams) {
    try {
      const parsed = JSON.parse(server.extraAuthorizeParams);
      if (parsed && typeof parsed === "object") {
        extraParams = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
      }
    } catch {
      // Malformed config must never break the authorize flow — log + ignore.
      console.warn(`[mcp-oauth] Ignoring malformed extraAuthorizeParams for server ${mcpServerId}`);
    }
  }

  const built = await buildAuthorizeUrl({
    authorizeUrl: client.authorizeUrl,
    tokenUrl: client.tokenUrl,
    clientId: client.clientId,
    redirectUri: callbackRedirectUri(),
    scopes,
    resource: client.resourceUrl,
    extraParams,
  });

  insertMcpOAuthPending({
    state: built.state,
    mcpServerId,
    userId,
    codeVerifier: built.codeVerifier,
    resourceUrl: client.resourceUrl,
    authorizationServerIssuer: client.authorizationServerIssuer,
    authorizeUrl: client.authorizeUrl,
    tokenUrl: client.tokenUrl,
    revocationUrl: client.revocationUrl,
    scopes: scopes.join(" "),
    dcrClientId: client.clientId,
    dcrClientSecret: client.clientSecret,
    redirectUri: callbackRedirectUri(),
    finalRedirect: q.redirect ?? null,
  });

  return built.url;
}

// ─── Callback completion (shared with the static /api/oauth/callback route) ──

interface OAuthCallbackParams {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

/**
 * Complete an MCP-flow OAuth callback: consume the `mcp` pending row, exchange
 * the code, upsert the token, and flip `authMethod=oauth`. Shared by the legacy
 * `/api/mcp-oauth/callback` route and the unified `/api/oauth/callback` route.
 * Returns false (without writing a response) when no `mcp` pending row matches
 * `state`, so the unified handler can report a single invalid-state error.
 */
export async function completeMcpOAuthCallback(
  res: ServerResponse,
  query: OAuthCallbackParams,
): Promise<boolean> {
  const state = query.state;
  if (!state) return false;
  const pending = consumeMcpOAuthPending(state);
  if (!pending) return false;

  const dashboardBaseUrl = pending.finalRedirect ?? defaultFinalRedirect(pending.mcpServerId);

  if (query.error) {
    const target = new URL(dashboardBaseUrl);
    target.searchParams.set("oauth", "error");
    target.searchParams.set("error", query.error);
    if (query.error_description) {
      target.searchParams.set("error_description", query.error_description);
    }
    res.writeHead(302, { Location: target.toString() });
    res.end();
    return true;
  }

  if (!query.code) {
    jsonError(res, "Missing authorization code", 400);
    return true;
  }

  try {
    const tokens = await exchangeCodeForTokens({
      tokenUrl: pending.tokenUrl,
      clientId: pending.dcrClientId ?? "",
      clientSecret: pending.dcrClientSecret ?? undefined,
      redirectUri: pending.redirectUri,
      code: query.code,
      codeVerifier: pending.codeVerifier,
      resource: pending.resourceUrl,
    });
    const existing = getMcpOAuthToken(pending.mcpServerId, pending.userId);
    const clientSource =
      existing?.clientSource ??
      (pending.dcrClientId ? ("dcr" as const) : ("preregistered" as const));

    upsertMcpOAuthToken({
      mcpServerId: pending.mcpServerId,
      userId: pending.userId,
      accessToken: tokens.access_token,
      ...(tokens.refresh_token != null ? { refreshToken: tokens.refresh_token } : {}),
      tokenType: tokens.token_type ?? "Bearer",
      expiresAt: computeExpiresAt(tokens.expires_in),
      scope: tokens.scope ?? pending.scopes ?? null,
      resourceUrl: pending.resourceUrl,
      authorizationServerIssuer: pending.authorizationServerIssuer,
      authorizeUrl: pending.authorizeUrl,
      tokenUrl: pending.tokenUrl,
      revocationUrl: pending.revocationUrl,
      dcrClientId: pending.dcrClientId,
      dcrClientSecret: pending.dcrClientSecret,
      clientSource,
      lastRefreshedAt: new Date().toISOString(),
    });

    // Flip authMethod=oauth so resolveSecrets picks this up.
    setMcpServerAuthMethod(pending.mcpServerId, "oauth");

    const target = new URL(dashboardBaseUrl);
    target.searchParams.set("oauth", "success");
    res.writeHead(302, { Location: target.toString() });
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mcp-oauth] callback exchange failed:", message);
    const target = new URL(dashboardBaseUrl);
    target.searchParams.set("oauth", "error");
    target.searchParams.set("error_description", message);
    res.writeHead(302, { Location: target.toString() });
    res.end();
  }
  return true;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleMcpOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  // GET /api/mcp-oauth/callback — public
  if (callbackRoute.match(req.method, pathSegments)) {
    const parsed = await callbackRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    if (!parsed.query.state) {
      jsonError(res, "Missing state parameter", 400);
      return true;
    }
    const handled = await completeMcpOAuthCallback(res, parsed.query);
    if (!handled) {
      jsonError(res, "Invalid or expired OAuth state", 400);
    }
    return true;
  }

  // GET /api/mcp-oauth/:id/status — returns sanitized token state (no secrets)
  if (statusRoute.match(req.method, pathSegments)) {
    const parsed = await statusRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const server = getMcpServerById(parsed.params.mcpServerId);
    if (!server) {
      jsonError(res, "MCP server not found", 404);
      return true;
    }

    const userId = parsed.query.userId ?? null;
    const token = getMcpOAuthToken(parsed.params.mcpServerId, userId);

    json(res, {
      mcpServerId: server.id,
      authMethod: server.authMethod,
      connected: !!token && token.status === "connected",
      token: token
        ? {
            id: token.id,
            status: token.status,
            tokenType: token.tokenType,
            expiresAt: token.expiresAt,
            scope: token.scope,
            lastErrorMessage: token.lastErrorMessage,
            lastRefreshedAt: token.lastRefreshedAt,
            authorizationServerIssuer: token.authorizationServerIssuer,
            resourceUrl: token.resourceUrl,
            clientSource: token.clientSource,
            hasRefreshToken: !!token.refreshToken,
            createdAt: token.createdAt,
            updatedAt: token.updatedAt,
          }
        : null,
    });
    return true;
  }

  // GET /api/mcp-oauth/:id/metadata
  if (metadataRoute.match(req.method, pathSegments)) {
    const parsed = await metadataRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const server = getMcpOrError(res, parsed.params.mcpServerId);
    if (!server) return true;

    try {
      const result = await discoverForMcp(server.url!);
      if (!result) {
        json(res, { requiresOAuth: false });
        return true;
      }
      json(res, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonError(res, `Metadata discovery failed: ${message}`, 502);
    }
    return true;
  }

  // GET /api/mcp-oauth/:id/authorize
  if (authorizeRoute.match(req.method, pathSegments)) {
    const parsed = await authorizeRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const server = getMcpOrError(res, parsed.params.mcpServerId);
    if (!server) return true;

    try {
      const providerUrl = await prepareAuthorizeFlow(
        res,
        parsed.params.mcpServerId,
        server,
        parsed.query,
      );
      if (!providerUrl) return true;
      res.writeHead(302, { Location: providerUrl });
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonError(res, `Authorize failed: ${message}`, 502);
    }
    return true;
  }

  // GET /api/mcp-oauth/:id/authorize-url — JSON variant of /authorize so the
  // dashboard can fetch the provider URL with Bearer auth and then navigate.
  if (authorizeUrlRoute.match(req.method, pathSegments)) {
    const parsed = await authorizeUrlRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const server = getMcpOrError(res, parsed.params.mcpServerId);
    if (!server) return true;

    try {
      const providerUrl = await prepareAuthorizeFlow(
        res,
        parsed.params.mcpServerId,
        server,
        parsed.query,
      );
      if (!providerUrl) return true;
      json(res, { providerUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonError(res, `Authorize failed: ${message}`, 502);
    }
    return true;
  }

  // POST /api/mcp-oauth/:id/refresh
  if (refreshRoute.match(req.method, pathSegments)) {
    const parsed = await refreshRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const userId = parsed.body?.userId ?? null;
    const existing = getMcpOAuthToken(parsed.params.mcpServerId, userId);
    if (!existing || !existing.refreshToken) {
      jsonError(res, "No refresh token available for this MCP server", 404);
      return true;
    }

    try {
      const refreshed = await refreshMcpToken({
        tokenUrl: existing.tokenUrl,
        clientId: existing.dcrClientId ?? "",
        clientSecret: existing.dcrClientSecret ?? undefined,
        refreshToken: existing.refreshToken,
        resource: existing.resourceUrl,
      });
      applyMcpOAuthRefresh(existing.id, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? undefined,
        expiresAt: computeExpiresAt(refreshed.expires_in),
        scope: refreshed.scope ?? null,
        expectedTokenVersion: existing.tokenVersion,
      });
      json(res, {
        ok: true,
        expiresAt: computeExpiresAt(refreshed.expires_in),
        scope: refreshed.scope ?? existing.scope,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonError(res, `Refresh failed: ${message}`, 500);
    }
    return true;
  }

  // DELETE /api/mcp-oauth/:id
  if (disconnectRoute.match(req.method, pathSegments)) {
    const parsed = await disconnectRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const userId = parsed.query.userId ?? null;
    const token = getMcpOAuthToken(parsed.params.mcpServerId, userId);
    if (!token) {
      jsonError(res, "No token for this MCP server", 404);
      return true;
    }

    if (token.revocationUrl && token.accessToken) {
      try {
        await revokeMcpToken({
          revocationUrl: token.revocationUrl,
          token: token.accessToken,
          tokenTypeHint: "access_token",
          clientId: token.dcrClientId ?? "",
          clientSecret: token.dcrClientSecret ?? undefined,
        });
      } catch (err) {
        console.warn(
          "[mcp-oauth] revocation call failed (continuing with local delete):",
          err instanceof Error ? err.message : err,
        );
      }
    }

    deleteMcpOAuthToken(parsed.params.mcpServerId, userId);
    // Flip back to static so resolveSecrets stops trying to inject Bearer.
    setMcpServerAuthMethod(parsed.params.mcpServerId, "static");
    json(res, { ok: true });
    return true;
  }

  // POST /api/mcp-oauth/:id/manual-client — pastes a pre-registered client
  if (manualClientRoute.match(req.method, pathSegments)) {
    const parsed = await manualClientRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const server = getMcpOrError(res, parsed.params.mcpServerId);
    if (!server) return true;

    try {
      // Discover (or take overrides) so we have authorize/token endpoints to store.
      const overrides = parsed.body;
      let authorizeUrl = overrides.authorizeUrl;
      let tokenUrl = overrides.tokenUrl;
      let revocationUrl = overrides.revocationUrl ?? null;
      let authorizationServerIssuer = overrides.authorizationServerIssuer ?? null;
      let resourceUrl = server.url!;
      let scopes = overrides.scopes ?? [];

      if (!authorizeUrl || !tokenUrl) {
        const discovery = await discoverForMcp(server.url!);
        if (!discovery) {
          jsonError(
            res,
            "Cannot auto-discover AS metadata; pass authorizeUrl/tokenUrl in the body.",
            400,
          );
          return true;
        }
        authorizeUrl = discovery.authorizeUrl;
        tokenUrl = discovery.tokenUrl;
        revocationUrl = revocationUrl ?? discovery.revocationUrl;
        authorizationServerIssuer =
          authorizationServerIssuer ?? discovery.authorizationServerIssuer;
        resourceUrl = discovery.resourceUrl;
        if (scopes.length === 0) scopes = discovery.scopes;
      }

      if (!authorizationServerIssuer) {
        jsonError(
          res,
          "authorizationServerIssuer is required when endpoints are provided manually.",
          400,
        );
        return true;
      }

      // Write the provisional token row with status='error' until /authorize
      // completes. The callback flips status=connected on success.
      upsertMcpOAuthToken({
        mcpServerId: parsed.params.mcpServerId,
        accessToken: "pending",
        refreshToken: null,
        expiresAt: null,
        scope: scopes.length > 0 ? scopes.join(" ") : null,
        resourceUrl,
        authorizationServerIssuer,
        authorizeUrl,
        tokenUrl,
        revocationUrl,
        dcrClientId: overrides.clientId,
        dcrClientSecret: overrides.clientSecret ?? null,
        clientSource: "manual",
        status: "error",
        lastErrorMessage: "Manual client pre-registered; awaiting authorize flow.",
      });
      json(res, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonError(res, `Manual-client registration failed: ${message}`, 500);
    }
    return true;
  }

  return false;
}

// Pending garbage collection now runs through the unified GC in
// `oauth-callback.ts` (`startOAuthPendingGc`), which sweeps all flows.

// Expose internal helpers for the resolveSecrets extension in mcp-servers.ts.
export { ensureMcpToken };
