import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getMcpServerById } from "../be/db";
import type { McpOAuthToken } from "../be/db-queries/mcp-oauth";
import {
  applyMcpOAuthRefresh,
  consumeMcpOAuthPending,
  deleteMcpOAuthToken,
  findReusableMcpOAuthClient,
  getMcpOAuthToken,
  insertMcpOAuthPending,
  invalidateMcpOAuthClient,
  markMcpOAuthTokenStatus,
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
  isInvalidClientError,
  refreshMcpToken,
  registerClient,
  revokeMcpToken,
} from "../oauth/mcp-wrapper";
import { McpAuthMethodSchema } from "../types";
import { getAppUrl, getPublicMcpBaseUrl } from "../utils/constants";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ssrfOptions() {
  return {
    allowPrivateHosts: isEnvFlagEnabled("MCP_OAUTH_ALLOW_PRIVATE_HOSTS", false),
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

// ─── Response schemas ────────────────────────────────────────────────────────
// Mirror the `DiscoveryResult` interface above and the handler bodies below —
// keep in sync by hand since these are local (non-DB-entity) response shapes.

const DiscoveryResultSchema = z.object({
  resourceUrl: z.string(),
  authorizationServerIssuer: z.string(),
  authorizeUrl: z.string(),
  tokenUrl: z.string(),
  revocationUrl: z.string().nullable(),
  registrationEndpoint: z.string().nullable(),
  scopes: z.array(z.string()),
  requiresOAuth: z.literal(true),
  dcrSupported: z.boolean(),
  bearerMethodsSupported: z.array(z.string()).nullable(),
});

const MetadataResponseSchema = z.union([
  z.object({ requiresOAuth: z.literal(false) }),
  DiscoveryResultSchema,
]);

const McpOAuthStatusResponseSchema = z.object({
  mcpServerId: z.string(),
  authMethod: McpAuthMethodSchema,
  connected: z.boolean(),
  token: z
    .object({
      id: z.string(),
      status: z.enum(["connected", "expired", "error", "revoked"]),
      tokenType: z.string(),
      expiresAt: z.string().nullable(),
      scope: z.string().nullable(),
      lastErrorMessage: z.string().nullable(),
      lastRefreshedAt: z.string().nullable(),
      authorizationServerIssuer: z.string(),
      resourceUrl: z.string(),
      clientSource: z.enum(["dcr", "manual", "preregistered"]),
      hasRefreshToken: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .nullable(),
});

const AuthorizeUrlResponseSchema = z.object({ providerUrl: z.string() });

const RefreshResponseSchema = z.object({
  ok: z.literal(true),
  expiresAt: z.string().nullable(),
  scope: z.string().nullable(),
});

const OkResponseSchema = z.object({ ok: z.literal(true) });

function splitScopes(scopes: string | null | undefined): string[] {
  return scopes?.split(/\s+/).filter(Boolean) ?? [];
}

/**
 * A registered DCR client is scoped to whatever it was registered with.
 * `requested` is covered only if every requested scope is already in
 * `registered` — an empty `registered` set (no scope restriction recorded)
 * does NOT count as "covers everything", since providers that enforce RFC
 * 7591 client scope metadata reject a token/authorize request for a scope
 * the client was never registered with.
 */
function scopesAreCovered(requested: string[], registered: string[]): boolean {
  const registeredSet = new Set(registered);
  return requested.every((scope) => registeredSet.has(scope));
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
    200: {
      description: "OAuth metadata or { requiresOAuth: false }",
      schema: MetadataResponseSchema,
    },
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
    200: {
      description: "Token status (never includes the token value itself)",
      schema: McpOAuthStatusResponseSchema,
    },
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
    200: { description: "{ providerUrl: string }", schema: AuthorizeUrlResponseSchema },
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
    200: { description: "Refreshed token", schema: RefreshResponseSchema },
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
    200: { description: "Token revoked/deleted", schema: OkResponseSchema },
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
    200: {
      description: "Pending client stored. Call /authorize to start the flow.",
      schema: OkResponseSchema,
    },
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

// ─── Per-connector+user authorize-flow lock ──────────────────────────────────
// Two concurrent first `/authorize` requests for the same (mcpServerId,
// userId) can otherwise both observe "no reusable client" from
// findReusableMcpOAuthClient, each register a fresh provider client before
// either reaches insertMcpOAuthPending, and race to persist — the later
// insert reuses/overwrites the earlier app row while its own pending context
// still points at the OTHER (now orphaned) client. That leaves duplicate
// provider registrations and can pair a connected authorization with the
// wrong client. Serialize the whole check-reusable-through-persist critical
// section per key so only one call at a time can decide "no reusable client
// exists, register one".
const authorizeFlowLocks = new Map<string, Promise<void>>();

function authorizeFlowLockKey(mcpServerId: string, userId: string | null): string {
  return `${mcpServerId}::${userId ?? "_"}`;
}

async function withAuthorizeFlowLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = authorizeFlowLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prior.then(() => mine);
  authorizeFlowLocks.set(key, chained);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (authorizeFlowLocks.get(key) === chained) {
      authorizeFlowLocks.delete(key);
    }
  }
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
  return withAuthorizeFlowLock(authorizeFlowLockKey(mcpServerId, userId), () =>
    runAuthorizeFlow(res, mcpServerId, server, q, userId),
  );
}

async function runAuthorizeFlow(
  res: ServerResponse,
  mcpServerId: string,
  server: NonNullable<ReturnType<typeof getMcpServerById>>,
  q: AuthorizeFlowQuery,
  userId: string | null,
): Promise<string | null> {
  let client = manualClientFromToken(getMcpOAuthToken(mcpServerId, userId));
  let discovery: DiscoveryResult | null = null;
  let registrationEndpoint: string | null = null;
  // Only set when THIS call freshly registers (or otherwise knows the true
  // registered set) — left undefined on reuse so the previously-recorded
  // value survives (see upsertMcpApp's `registeredScopes` doc).
  let registeredScopes: string[] | undefined;

  if (!client) {
    // Reuse a previously-registered DCR client for this connector+user
    // instead of hitting the provider's registration endpoint again — either
    // an already-connected client (re-authorizing) or a still-live pending
    // attempt (retrying before it's completed/GC'd). Discovery is still run
    // (cheap metadata GET, not a mutating registration) to get the current
    // authorize/token URLs and to confirm the AS identity hasn't moved.
    const reusable = findReusableMcpOAuthClient(mcpServerId, userId);
    discovery = await discoverForMcp(server.url!);
    if (!discovery) {
      jsonError(res, "MCP server does not require OAuth", 400);
      return null;
    }
    registrationEndpoint = discovery.registrationEndpoint;

    // A caller-requested scope set that the stored client wasn't registered
    // with must not be silently narrowed to the stored client's scopes —
    // fall through to fresh registration below instead of reusing. With no
    // explicit request, fall back to what would actually be sent
    // (discovery.scopes, same as the else-branch below) so the coverage
    // check below still catches an empty registered set against a
    // non-empty advertised one — see scopesAreCovered's docstring.
    const requestedScopes = q.scopes ? splitScopes(q.scopes) : null;
    const scopesToRequest = requestedScopes ?? discovery.scopes;

    if (
      reusable &&
      reusable.authorizationServerIssuer === discovery.authorizationServerIssuer &&
      // A stored null means the client was registered before we persisted
      // this field — treat it as unknown rather than as a mismatch, or every
      // pre-existing connector re-registers on each abandoned authorize call.
      (reusable.registrationEndpoint === null ||
        reusable.registrationEndpoint === discovery.registrationEndpoint) &&
      // "" is the legacy/unrecorded sentinel: migration 117 backfilled it for
      // every pre-existing MCP app row, and connects before we persisted
      // pending.redirectUri wrote it too. Treat it as unknown rather than a
      // mismatch, same as a null registrationEndpoint above.
      (reusable.redirectUri === "" || reusable.redirectUri === callbackRedirectUri()) &&
      // Compare against the REGISTERED scope set, not the granted one — a
      // provider that narrows the granted token scope below what the client
      // was registered with (the common case) must not make every later
      // /authorize believe the stored client needs re-registering. A null
      // registeredScopes is a legacy row from before this field existed (see
      // migration 117) and its true registered set is unknown — unlike
      // registrationEndpoint/redirectUri above, "unknown" must NOT be treated
      // as "compatible with anything": we have no evidence the provider ever
      // granted this client any scope beyond none, so require the requested
      // set to be empty (or force the one fresh DCR needed to establish a
      // known set). Do not substitute the granted token scope here — that is
      // the exact bug this series fixed for the known-scope case.
      scopesAreCovered(scopesToRequest, reusable.registeredScopes ?? [])
    ) {
      // We know the true registered set here — record it so a pending row
      // backing THIS reused authorize call doesn't fall back to a literal
      // null if this is the flow that ends up completing. A legacy-unknown
      // reuse only reaches this branch when scopesToRequest was empty, so
      // recording `[]` (rather than leaving it undefined) is accurate: this
      // flow observed no scope requirement, same as a fresh empty-scope DCR.
      registeredScopes = reusable.registeredScopes ?? [];
      client = {
        clientId: reusable.clientId,
        clientSecret: reusable.clientSecret,
        resourceUrl: discovery.resourceUrl,
        authorizationServerIssuer: discovery.authorizationServerIssuer,
        authorizeUrl: discovery.authorizeUrl,
        tokenUrl: discovery.tokenUrl,
        revocationUrl: discovery.revocationUrl,
        scopes: reusable.scopes.length > 0 ? reusable.scopes : discovery.scopes,
      };
    }
  }

  if (!client) {
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

    registeredScopes = scopes;
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
    registrationEndpoint,
    authorizeUrl: client.authorizeUrl,
    tokenUrl: client.tokenUrl,
    revocationUrl: client.revocationUrl,
    scopes: scopes.join(" "),
    registeredScopes,
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
    // A provider that rejects the client at the AUTHORIZE endpoint (rather
    // than the token endpoint) never reaches the exchange try/catch below,
    // so without this the stored client stays "reusable" until GC drops the
    // orphaned pending row — a floor of 10 minutes, not a bound. Same
    // wrong-target guard as the exchange-failure path below.
    if (isInvalidClientError(query.error) || query.error === "unauthorized_client") {
      const connected = getMcpOAuthToken(pending.mcpServerId, pending.userId);
      if (!connected || connected.dcrClientId === pending.dcrClientId) {
        invalidateMcpOAuthClient(pending.mcpServerId, pending.userId);
      }
    }
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
      registrationEndpoint: pending.registrationEndpoint,
      authorizeUrl: pending.authorizeUrl,
      tokenUrl: pending.tokenUrl,
      revocationUrl: pending.revocationUrl,
      redirectUri: pending.redirectUri,
      // undefined (not null) when the pending row doesn't know one — this
      // app row's app may not have been recreated by the orphan-app deletion
      // above, and an explicit null would wipe out an already-correct value.
      registeredScopes: pending.registeredScopes ?? undefined,
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
    if (isInvalidClientError(message)) {
      // The provider rejected the client we stored — invalidate it so the
      // next /authorize call re-registers exactly once instead of retrying
      // with a client the provider has already disowned. Only invalidate the
      // client the provider actually rejected: when this flow used a freshly
      // registered client (AS identity, redirect URI, or scope set moved),
      // the connected app still holds a different, working client_id, and
      // invalidating it would corrupt a working connection.
      const connected = getMcpOAuthToken(pending.mcpServerId, pending.userId);
      if (!connected || connected.dcrClientId === pending.dcrClientId) {
        invalidateMcpOAuthClient(pending.mcpServerId, pending.userId);
      }
    }
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

    statusRoute.respond(res, 200, {
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
        metadataRoute.respond(res, 200, { requiresOAuth: false });
        return true;
      }
      metadataRoute.respond(res, 200, result);
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
      authorizeUrlRoute.respond(res, 200, { providerUrl });
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
      refreshRoute.respond(res, 200, {
        ok: true,
        expiresAt: computeExpiresAt(refreshed.expires_in),
        scope: refreshed.scope ?? existing.scope,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isInvalidClientError(message)) {
        // The provider has disowned this client — invalidate it so the next
        // /authorize call re-registers exactly once instead of continuing to
        // refresh against a client_id the provider now rejects.
        invalidateMcpOAuthClient(parsed.params.mcpServerId, userId);
        markMcpOAuthTokenStatus(existing.id, "error", message);
      }
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
    disconnectRoute.respond(res, 200, { ok: true });
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
      manualClientRoute.respond(res, 200, { ok: true });
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
