#!/usr/bin/env bun
/**
 * Dummy OAuth 2.0 MCP Server
 *
 * A minimal, self-contained MCP server that speaks OAuth 2.1 (PKCE
 * authorization-code + RFC 7591 Dynamic Client Registration + RFC 8707
 * resource indicator + RFC 9728 protected-resource metadata).
 *
 * Purpose: exercise the full discovery → register → authorize → token →
 * authenticated MCP call loop against the agent-swarm OAuth MCP client in
 * PR #357 (https://github.com/desplega-ai/agent-swarm/pull/357).
 *
 * Everything is in-memory (no DB). Issued codes, client registrations, and
 * access tokens are printed to stdout so the flow is easy to follow.
 *
 * ▶ Usage:
 *   bun run scripts/dummy-oauth-mcp/server.ts            # port 4455
 *   bun run scripts/dummy-oauth-mcp/server.ts 4600       # custom port
 *   PORT=4600 bun run scripts/dummy-oauth-mcp/server.ts  # via env
 *
 * See scripts/dummy-oauth-mcp/README.md for full end-to-end usage.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = Number.parseInt(process.argv[2] ?? process.env.PORT ?? "4455", 10);
const BASE = process.env.DUMMY_OAUTH_BASE_URL ?? `http://localhost:${PORT}`;
const ISSUER = BASE;
const RESOURCE_URL = `${BASE}/mcp`;
const SCOPES_SUPPORTED = ["mcp.read", "mcp.call"];
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 min
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1h
const REFRESH_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ─── In-memory stores ────────────────────────────────────────────────────────

interface RegisteredClient {
  client_id: string;
  client_secret: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  issued_at: number;
}

interface PendingAuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string; // "S256"
  scope: string;
  resource: string;
  issuedAt: number;
  state?: string;
}

interface IssuedToken {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

const clients = new Map<string, RegisteredClient>();
const pendingCodes = new Map<string, PendingAuthCode>();
const tokens = new Map<string, IssuedToken>(); // by accessToken
const refreshTokens = new Map<string, IssuedToken>(); // by refreshToken

// MCP transport sessions keyed by mcp-session-id
const mcpTransports: Record<string, StreamableHTTPServerTransport> = {};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function jsonError(
  res: ServerResponse,
  error: string,
  description?: string,
  status = 400,
): void {
  json(res, { error, error_description: description }, status);
}

function html(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function base64UrlEncode(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(value: string): Promise<Buffer> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function randomToken(bytes = 32): string {
  return base64UrlEncode(randomBytes(bytes));
}

function logEvent(label: string, payload: Record<string, unknown> = {}): void {
  console.log(`[dummy-oauth-mcp] ${label}`, payload);
}

// ─── OAuth endpoints ─────────────────────────────────────────────────────────

/** RFC 9728 — Protected Resource Metadata */
function handleProtectedResourceMetadata(res: ServerResponse): void {
  json(res, {
    resource: RESOURCE_URL,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPES_SUPPORTED,
    resource_documentation: `${BASE}/`,
  });
}

/** RFC 8414 — Authorization Server Metadata */
function handleAuthServerMetadata(res: ServerResponse): void {
  json(res, {
    issuer: ISSUER,
    authorization_endpoint: `${BASE}/authorize`,
    token_endpoint: `${BASE}/token`,
    registration_endpoint: `${BASE}/register`,
    revocation_endpoint: `${BASE}/revoke`,
    scopes_supported: SCOPES_SUPPORTED,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
  });
}

/** RFC 7591 — Dynamic Client Registration */
async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    jsonError(res, "invalid_client_metadata", "Request body is not valid JSON");
    return;
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    jsonError(res, "invalid_redirect_uri", "redirect_uris is required");
    return;
  }

  const client: RegisteredClient = {
    client_id: `dcr-${randomUUID()}`,
    client_secret: randomToken(24),
    client_name: typeof body.client_name === "string" ? body.client_name : "dummy-client",
    redirect_uris: redirectUris.filter((u): u is string => typeof u === "string"),
    token_endpoint_auth_method:
      typeof body.token_endpoint_auth_method === "string"
        ? body.token_endpoint_auth_method
        : "client_secret_basic",
    grant_types: Array.isArray(body.grant_types)
      ? (body.grant_types as string[])
      : ["authorization_code", "refresh_token"],
    issued_at: Math.floor(Date.now() / 1000),
  };
  clients.set(client.client_id, client);
  logEvent("client registered", {
    client_id: client.client_id,
    redirect_uris: client.redirect_uris,
    name: client.client_name,
  });

  json(
    res,
    {
      client_id: client.client_id,
      client_secret: client.client_secret,
      client_id_issued_at: client.issued_at,
      client_secret_expires_at: 0, // never expires
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: ["code"],
    },
    201,
  );
}

/** GET /authorize — shows a tiny HTML consent page (or auto-approves) */
function handleAuthorize(
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): void {
  const clientId = query.get("client_id");
  const redirectUri = query.get("redirect_uri");
  const responseType = query.get("response_type");
  const codeChallenge = query.get("code_challenge");
  const codeChallengeMethod = query.get("code_challenge_method") ?? "S256";
  const scope = query.get("scope") ?? SCOPES_SUPPORTED.join(" ");
  const state = query.get("state") ?? undefined;
  const resource = query.get("resource") ?? RESOURCE_URL;
  const autoApprove = query.get("auto_approve") === "1";

  if (!clientId || !redirectUri) {
    jsonError(res, "invalid_request", "client_id and redirect_uri are required");
    return;
  }
  const client = clients.get(clientId);
  if (!client) {
    jsonError(res, "invalid_client", `Unknown client_id ${clientId}`);
    return;
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    jsonError(res, "invalid_redirect_uri", `redirect_uri not registered for ${clientId}`);
    return;
  }
  if (responseType !== "code") {
    jsonError(res, "unsupported_response_type", "Only response_type=code is supported");
    return;
  }
  if (!codeChallenge) {
    jsonError(res, "invalid_request", "PKCE code_challenge is required");
    return;
  }
  if (codeChallengeMethod !== "S256") {
    jsonError(res, "invalid_request", "Only code_challenge_method=S256 is supported");
    return;
  }

  const issueCode = (): string => {
    const code = `code-${randomToken(16)}`;
    pendingCodes.set(code, {
      code,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
      resource,
      issuedAt: Date.now(),
      state,
    });
    logEvent("authorization code issued", {
      code,
      client_id: clientId,
      resource,
      scope,
    });
    return code;
  };

  const buildRedirect = (code: string): string => {
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return url.toString();
  };

  if (autoApprove || req.headers["x-auto-approve"] === "1") {
    const code = issueCode();
    res.writeHead(302, { Location: buildRedirect(code) });
    res.end();
    return;
  }

  // Render a trivial consent page. Single "Approve" button POSTs back here.
  const safe = (v: string) => v.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
  html(
    res,
    `<!doctype html>
<meta charset="utf-8">
<title>Dummy OAuth — consent</title>
<body style="font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5">
<h2>Dummy OAuth MCP — authorize?</h2>
<p><b>Client:</b> ${safe(client.client_name)} (<code>${safe(clientId)}</code>)</p>
<p><b>Resource:</b> <code>${safe(resource)}</code></p>
<p><b>Scopes:</b> <code>${safe(scope)}</code></p>
<p><b>Redirect:</b> <code>${safe(redirectUri)}</code></p>
<form method="POST" action="/authorize/consent" style="margin-top:24px">
  <input type="hidden" name="client_id" value="${safe(clientId)}">
  <input type="hidden" name="redirect_uri" value="${safe(redirectUri)}">
  <input type="hidden" name="scope" value="${safe(scope)}">
  <input type="hidden" name="resource" value="${safe(resource)}">
  <input type="hidden" name="code_challenge" value="${safe(codeChallenge)}">
  <input type="hidden" name="code_challenge_method" value="${safe(codeChallengeMethod)}">
  ${state ? `<input type="hidden" name="state" value="${safe(state)}">` : ""}
  <button type="submit" style="padding:8px 20px;font-size:16px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer">Approve</button>
</form>
<p style="color:#6b7280;margin-top:16px;font-size:13px">Tip: append <code>&amp;auto_approve=1</code> to the authorize URL to skip this page.</p>
</body>`,
  );
}

async function handleAuthorizeConsent(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  const form = new URLSearchParams(raw);
  const clientId = form.get("client_id");
  const redirectUri = form.get("redirect_uri");
  const codeChallenge = form.get("code_challenge");
  const codeChallengeMethod = form.get("code_challenge_method") ?? "S256";
  const scope = form.get("scope") ?? SCOPES_SUPPORTED.join(" ");
  const state = form.get("state") ?? undefined;
  const resource = form.get("resource") ?? RESOURCE_URL;

  if (!clientId || !redirectUri || !codeChallenge) {
    jsonError(res, "invalid_request", "Missing consent form fields");
    return;
  }
  const client = clients.get(clientId);
  if (!client || !client.redirect_uris.includes(redirectUri)) {
    jsonError(res, "invalid_client", "Unknown client or redirect_uri");
    return;
  }

  const code = `code-${randomToken(16)}`;
  pendingCodes.set(code, {
    code,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope,
    resource,
    issuedAt: Date.now(),
    state,
  });
  logEvent("authorization code issued (consent)", {
    code,
    client_id: clientId,
    resource,
    scope,
  });

  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.writeHead(302, { Location: url.toString() });
  res.end();
}

/** POST /token — authorization_code + refresh_token grants */
async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const form = new URLSearchParams(raw);
  const grantType = form.get("grant_type");

  // Client auth: accept either client_secret_basic or client_secret_post, or
  // none if the client was registered as public.
  const authHeader = req.headers.authorization;
  let clientId = form.get("client_id") ?? undefined;
  let clientSecret = form.get("client_secret") ?? undefined;
  if (authHeader?.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx > 0) {
      clientId = clientId ?? decodeURIComponent(decoded.slice(0, idx));
      clientSecret = clientSecret ?? decodeURIComponent(decoded.slice(idx + 1));
    }
  }

  if (!clientId) {
    jsonError(res, "invalid_client", "client_id is required");
    return;
  }
  const client = clients.get(clientId);
  if (!client) {
    jsonError(res, "invalid_client", `Unknown client_id ${clientId}`);
    return;
  }
  // Accept missing secret for "none" auth, otherwise check.
  if (client.token_endpoint_auth_method !== "none") {
    if (!clientSecret || clientSecret !== client.client_secret) {
      jsonError(res, "invalid_client", "Client secret mismatch", 401);
      return;
    }
  }

  if (grantType === "authorization_code") {
    const code = form.get("code");
    const codeVerifier = form.get("code_verifier");
    const redirectUri = form.get("redirect_uri");
    const resource = form.get("resource") ?? RESOURCE_URL;

    if (!code || !codeVerifier || !redirectUri) {
      jsonError(res, "invalid_request", "code, code_verifier, redirect_uri required");
      return;
    }
    const pending = pendingCodes.get(code);
    if (!pending) {
      jsonError(res, "invalid_grant", "Unknown or already-used authorization code");
      return;
    }
    pendingCodes.delete(code); // single-use
    if (Date.now() - pending.issuedAt > AUTH_CODE_TTL_MS) {
      jsonError(res, "invalid_grant", "Authorization code expired");
      return;
    }
    if (pending.clientId !== clientId) {
      jsonError(res, "invalid_grant", "client_id does not match the one that requested the code");
      return;
    }
    if (pending.redirectUri !== redirectUri) {
      jsonError(res, "invalid_grant", "redirect_uri mismatch");
      return;
    }
    // PKCE S256 verification
    const expectedChallenge = base64UrlEncode(await sha256(codeVerifier));
    if (expectedChallenge !== pending.codeChallenge) {
      jsonError(res, "invalid_grant", "PKCE code_verifier mismatch");
      return;
    }
    // Resource indicator binding (RFC 8707)
    if (resource !== pending.resource) {
      jsonError(
        res,
        "invalid_target",
        `resource ${resource} does not match the one bound to this authorization code (${pending.resource})`,
      );
      return;
    }

    const issued = issueTokenPair(client, pending.scope, pending.resource);
    logEvent("access token issued (authorization_code)", {
      client_id: client.client_id,
      resource: issued.resource,
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    });
    json(res, {
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: issued.refreshToken,
      scope: issued.scope,
    });
    return;
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token");
    const resource = form.get("resource") ?? RESOURCE_URL;
    if (!refreshToken) {
      jsonError(res, "invalid_request", "refresh_token is required");
      return;
    }
    const existing = refreshTokens.get(refreshToken);
    if (!existing) {
      jsonError(res, "invalid_grant", "Unknown refresh_token");
      return;
    }
    if (existing.clientId !== clientId) {
      jsonError(res, "invalid_grant", "refresh_token does not belong to this client");
      return;
    }
    if (resource !== existing.resource) {
      jsonError(res, "invalid_target", "resource mismatch on refresh");
      return;
    }
    // Rotate: invalidate old tokens, issue new pair
    tokens.delete(existing.accessToken);
    refreshTokens.delete(existing.refreshToken);
    const issued = issueTokenPair(client, existing.scope, existing.resource);
    logEvent("access token issued (refresh_token)", {
      client_id: client.client_id,
      resource: issued.resource,
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
    });
    json(res, {
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: issued.refreshToken,
      scope: issued.scope,
    });
    return;
  }

  jsonError(res, "unsupported_grant_type", `Unsupported grant_type: ${grantType}`);
}

function issueTokenPair(
  client: RegisteredClient,
  scope: string,
  resource: string,
): IssuedToken {
  const issued: IssuedToken = {
    accessToken: `at-${randomToken(24)}`,
    refreshToken: `rt-${randomToken(32)}`,
    clientId: client.client_id,
    scope,
    resource,
    expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
  };
  tokens.set(issued.accessToken, issued);
  refreshTokens.set(issued.refreshToken, issued);
  // TTL on refresh token: schedule cleanup
  setTimeout(() => {
    refreshTokens.delete(issued.refreshToken);
  }, REFRESH_TOKEN_TTL_MS).unref?.();
  return issued;
}

/** RFC 7009 — token revocation */
async function handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const form = new URLSearchParams(raw);
  const token = form.get("token");
  if (!token) {
    // Per RFC 7009, always return 200 regardless of input to avoid leaks.
    res.writeHead(200);
    res.end();
    return;
  }
  const issued = tokens.get(token) ?? refreshTokens.get(token);
  if (issued) {
    tokens.delete(issued.accessToken);
    refreshTokens.delete(issued.refreshToken);
    logEvent("token revoked", { token });
  }
  res.writeHead(200);
  res.end();
}

// ─── MCP endpoint (Bearer-protected) ─────────────────────────────────────────

function buildMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "dummy-oauth-mcp",
      version: "0.1.0",
      description: "Dummy OAuth 2.1 MCP server for agent-swarm PR #357 testing",
    },
    { capabilities: {} },
  );

  server.registerTool(
    "ping",
    {
      title: "ping",
      description: "Returns a timestamp and the caller's client_id (proves auth worked).",
      inputSchema: {
        message: z.string().optional().describe("Optional echo message"),
      },
    },
    async ({ message }) => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                timestamp: new Date().toISOString(),
                echoed: message ?? null,
                server: "dummy-oauth-mcp",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "whoami",
    {
      title: "whoami",
      description: "Returns the OAuth client bound to the current bearer token.",
      inputSchema: {},
    },
    async (_args, meta) => {
      // meta.authInfo is populated by the bearer validator via request-scoped state
      const info = (
        meta as unknown as { authInfo?: { clientId: string; scope: string; resource: string } }
      ).authInfo;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                client_id: info?.clientId ?? null,
                scope: info?.scope ?? null,
                resource: info?.resource ?? null,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}

function bearerUnauthorized(res: ServerResponse, description: string): void {
  // RFC 9728 — advertise the protected-resource metadata URL so MCP clients
  // can auto-discover the AS without being pre-configured.
  const metadataUrl = `${BASE}/.well-known/oauth-protected-resource`;
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="${description}"`,
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: description },
      id: null,
    }),
  );
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // RFC 9728 discovery probe: MCP clients (including PR #357) may HEAD the
  // resource URL before any Authorization header is present. Respond 401 with
  // the WWW-Authenticate metadata pointer so discovery works both via
  // /.well-known and via the probe.
  if (req.method === "HEAD") {
    const metadataUrl = `${BASE}/.well-known/oauth-protected-resource`;
    res.writeHead(401, {
      "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`,
    });
    res.end();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    bearerUnauthorized(res, "Missing Bearer token");
    return;
  }
  const accessToken = authHeader.slice(7).trim();
  const issued = tokens.get(accessToken);
  if (!issued) {
    bearerUnauthorized(res, "Unknown access token");
    return;
  }
  if (Date.now() > issued.expiresAt) {
    tokens.delete(accessToken);
    bearerUnauthorized(res, "Access token expired");
    return;
  }

  // Streamable HTTP transport (matches src/http/mcp.ts exactly).
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST") {
    const bodyText = await readBody(req);
    const body = bodyText ? JSON.parse(bodyText) : {};

    let transport: StreamableHTTPServerTransport;
    if (sessionId && mcpTransports[sessionId]) {
      transport = mcpTransports[sessionId]!;
    } else if (!sessionId && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          mcpTransports[id] = transport;
        },
        onsessionclosed: (id) => {
          delete mcpTransports[id];
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete mcpTransports[transport.sessionId];
      };
      const mcp = buildMcpServer();
      await mcp.connect(transport);
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Invalid session" },
          id: null,
        }),
      );
      return;
    }

    // Propagate auth context so tools can read it via meta.
    (transport as unknown as { _authInfo?: unknown })._authInfo = {
      clientId: issued.clientId,
      scope: issued.scope,
      resource: issued.resource,
    };

    await transport.handleRequest(req, res, body);
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    if (sessionId && mcpTransports[sessionId]) {
      await mcpTransports[sessionId]!.handleRequest(req, res);
      return;
    }
    res.writeHead(400);
    res.end("Invalid session");
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
}

// ─── HTTP router ─────────────────────────────────────────────────────────────

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", BASE);
  const { pathname } = url;

  // CORS: allow local dashboards to probe metadata without friction.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,HEAD,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, mcp-session-id, Accept",
  );
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === "GET" && pathname === "/") {
      json(res, {
        ok: true,
        name: "dummy-oauth-mcp",
        resource: RESOURCE_URL,
        issuer: ISSUER,
        discovery: {
          protected_resource: `${BASE}/.well-known/oauth-protected-resource`,
          authorization_server: `${BASE}/.well-known/oauth-authorization-server`,
        },
      });
      return;
    }

    if (req.method === "GET" && pathname === "/.well-known/oauth-protected-resource") {
      return handleProtectedResourceMetadata(res);
    }
    if (req.method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
      return handleAuthServerMetadata(res);
    }
    if (req.method === "POST" && pathname === "/register") {
      return handleRegister(req, res);
    }
    if (req.method === "GET" && pathname === "/authorize") {
      return handleAuthorize(req, res, url.searchParams);
    }
    if (req.method === "POST" && pathname === "/authorize/consent") {
      return handleAuthorizeConsent(req, res);
    }
    if (req.method === "POST" && pathname === "/token") {
      return handleToken(req, res);
    }
    if (req.method === "POST" && pathname === "/revoke") {
      return handleRevoke(req, res);
    }
    if (pathname === "/mcp") {
      return handleMcp(req, res);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", path: pathname }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[dummy-oauth-mcp] error:", err);
    if (!res.headersSent) {
      jsonError(res, "server_error", message, 500);
    } else {
      res.end();
    }
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

function start(): void {
  const server = createHttpServer((req, res) => {
    void route(req, res);
  });
  server.listen(PORT, () => {
    console.log(`┌─ dummy-oauth-mcp ────────────────────────────────────────────`);
    console.log(`│ Listening on ${BASE}`);
    console.log(`│ Resource URL:           ${RESOURCE_URL}`);
    console.log(`│ Protected-resource meta: ${BASE}/.well-known/oauth-protected-resource`);
    console.log(`│ AS metadata:            ${BASE}/.well-known/oauth-authorization-server`);
    console.log(`│ Register (DCR):         POST ${BASE}/register`);
    console.log(`│ Authorize:              GET  ${BASE}/authorize`);
    console.log(`│ Token:                  POST ${BASE}/token`);
    console.log(`│ MCP (Bearer-gated):     POST ${BASE}/mcp`);
    console.log(`└──────────────────────────────────────────────────────────────`);
    console.log("Tip: issued codes/tokens are printed on stdout as they happen.");
  });
}

start();
