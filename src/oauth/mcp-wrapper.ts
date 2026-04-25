import * as oauth from "oauth4webapi";

/**
 * MCP OAuth 2.1 wrapper.
 *
 * Extends the Linear tracker precedent (`src/oauth/wrapper.ts`) with:
 *   - RFC 9728 Protected Resource Metadata discovery.
 *   - RFC 8414 Authorization Server metadata fallback.
 *   - RFC 7591 Dynamic Client Registration (with manual-client fallback).
 *   - RFC 8707 Resource Indicators (`resource=` param on /authorize + /token).
 *   - SSRF guard on every outbound metadata/registration/token fetch.
 *
 * Token persistence is NOT part of this module — callers decide where to put
 * the rows (DB via `src/be/db-queries/mcp-oauth.ts`). That keeps this file
 * testable without a DB.
 */

// ─── SSRF guard ──────────────────────────────────────────────────────────────

const PRIVATE_IPV4_BLOCKS = [
  { prefix: "10.", mask: 8 },
  { prefix: "127.", mask: 8 },
  { prefix: "169.254.", mask: 16 },
  { prefix: "172.16.", mask: 12 }, // 172.16/12 covers 172.16-31 — approximation
  { prefix: "192.168.", mask: 16 },
  { prefix: "0.", mask: 8 },
];

function isPrivateIPv4(host: string): boolean {
  if (host === "127.0.0.1") return true;
  if (host.startsWith("169.254.")) return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (host.startsWith("0.")) return true;
  // 172.16.0.0/12 covers 172.16.0.0 – 172.31.255.255
  if (host.startsWith("172.")) {
    const parts = host.split(".");
    const second = parseInt(parts[1] ?? "", 10);
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
  }
  for (const block of PRIVATE_IPV4_BLOCKS) {
    if (block.prefix !== "172." && host.startsWith(block.prefix)) return true;
  }
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "[::1]") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("[fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("[fc") || lower.startsWith("[fd")) return true;
  return false;
}

export interface SsrfGuardOptions {
  /** Allow loopback and RFC1918 hosts (dev / self-hosting). Opt-in only. */
  allowPrivateHosts?: boolean;
  /** Allow http:// URLs (dev). In production only https:// is accepted. */
  allowInsecure?: boolean;
}

export function assertUrlSafe(rawUrl: string, opts: SsrfGuardOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  const allowPrivate = opts.allowPrivateHosts === true;
  const allowInsecure = opts.allowInsecure === true;

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing unsupported protocol: ${parsed.protocol}`);
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new Error(`Refusing insecure (http://) URL in production: ${rawUrl}`);
  }

  const host = parsed.hostname;
  if (!host) {
    throw new Error(`Missing hostname: ${rawUrl}`);
  }

  if (host === "localhost" && !allowPrivate) {
    throw new Error(`Refusing loopback hostname: ${host}`);
  }
  if (isPrivateIPv4(host) && !allowPrivate) {
    throw new Error(`Refusing private IPv4 host: ${host}`);
  }
  if (isPrivateIPv6(host) && !allowPrivate) {
    throw new Error(`Refusing private IPv6 host: ${host}`);
  }

  return parsed;
}

function defaultSsrfOptions(): SsrfGuardOptions {
  return {
    allowPrivateHosts: process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS === "true",
    allowInsecure: process.env.NODE_ENV !== "production",
  };
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  assertUrlSafe(url, defaultSsrfOptions());
  return fetch(url, init);
}

// ─── Protected Resource Metadata (RFC 9728) ──────────────────────────────────

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  bearer_methods_supported?: string[];
  scopes_supported?: string[];
  resource_documentation?: string;
}

/**
 * Discover the AS that protects a given MCP resource URL.
 *
 * Discovery order:
 *   1. GET <resourceUrl>/.well-known/oauth-protected-resource
 *   2. If no PRMD, HEAD the MCP URL and parse `WWW-Authenticate: Bearer resource_metadata="…"`.
 *   3. Throw — caller should present the manual-client fallback.
 */
export async function discoverProtectedResourceMetadata(
  resourceUrl: string,
): Promise<ProtectedResourceMetadata | null> {
  const base = new URL(resourceUrl);
  const wellKnown = new URL("/.well-known/oauth-protected-resource", base).toString();

  try {
    const res = await safeFetch(wellKnown, {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      return (await res.json()) as ProtectedResourceMetadata;
    }
  } catch {
    // fall through to WWW-Authenticate probe
  }

  try {
    const probe = await safeFetch(resourceUrl, { method: "HEAD" });
    const wwwAuth = probe.headers.get("www-authenticate");
    if (wwwAuth) {
      const match = /resource_metadata="([^"]+)"/i.exec(wwwAuth);
      if (match) {
        const metaRes = await safeFetch(match[1]!, {
          headers: { Accept: "application/json" },
        });
        if (metaRes.ok) {
          return (await metaRes.json()) as ProtectedResourceMetadata;
        }
      }
    }
  } catch {
    // fall through
  }

  return null;
}

// ─── Authorization Server Metadata (RFC 8414) ────────────────────────────────

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

/**
 * Discover AS metadata, trying RFC 8414 (`/.well-known/oauth-authorization-server`)
 * first and falling back to OIDC (`/.well-known/openid-configuration`).
 */
export async function discoverAuthorizationServerMetadata(
  issuer: string,
): Promise<AuthorizationServerMetadata> {
  const issuerUrl = new URL(issuer);
  const candidates = [
    new URL("/.well-known/oauth-authorization-server", issuerUrl).toString(),
    new URL("/.well-known/openid-configuration", issuerUrl).toString(),
  ];

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const res = await safeFetch(candidate, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        return (await res.json()) as AuthorizationServerMetadata;
      }
      lastError = new Error(`Metadata fetch ${candidate} → ${res.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error(`Authorization server metadata not found at ${issuer}`);
}

// ─── Dynamic Client Registration (RFC 7591) ──────────────────────────────────

export interface DcrRequest {
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  application_type?: string;
  scope?: string;
}

export interface DcrResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  token_endpoint_auth_method?: string;
}

export async function registerClient(
  registrationEndpoint: string,
  req: DcrRequest,
): Promise<DcrResponse> {
  const res = await safeFetch(registrationEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dynamic client registration failed (${res.status}): ${body}`);
  }
  return (await res.json()) as DcrResponse;
}

// ─── Authorization URL + token exchange ──────────────────────────────────────

export interface BuildAuthorizeInput {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  /** RFC 8707 resource indicator — canonical MCP URL. */
  resource: string;
  state?: string;
  extraParams?: Record<string, string>;
}

export interface BuiltAuthorize {
  url: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

export async function buildAuthorizeUrl(input: BuildAuthorizeInput): Promise<BuiltAuthorize> {
  const state = input.state ?? oauth.generateRandomState();
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

  const url = new URL(input.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  if (input.scopes.length > 0) {
    url.searchParams.set("scope", input.scopes.join(" "));
  }
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resource);

  if (input.extraParams) {
    for (const [k, v] of Object.entries(input.extraParams)) {
      url.searchParams.set(k, v);
    }
  }

  return { url: url.toString(), state, codeVerifier, codeChallenge };
}

export interface ExchangeCodeInput {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string | null;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  resource: string;
}

export interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export async function exchangeCodeForTokens(input: ExchangeCodeInput): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
    resource: input.resource,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);

  const res = await safeFetch(input.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

export interface RefreshTokenInput {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string | null;
  refreshToken: string;
  resource: string;
  scopes?: string[];
}

export async function refreshMcpToken(input: RefreshTokenInput): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    resource: input.resource,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  if (input.scopes && input.scopes.length > 0) body.set("scope", input.scopes.join(" "));

  const res = await safeFetch(input.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

export interface RevokeInput {
  revocationUrl: string;
  token: string;
  tokenTypeHint?: "access_token" | "refresh_token";
  clientId: string;
  clientSecret?: string | null;
}

export async function revokeMcpToken(input: RevokeInput): Promise<void> {
  const body = new URLSearchParams({
    token: input.token,
    client_id: input.clientId,
  });
  if (input.tokenTypeHint) body.set("token_type_hint", input.tokenTypeHint);
  if (input.clientSecret) body.set("client_secret", input.clientSecret);

  const res = await safeFetch(input.revocationUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok && res.status !== 200 && res.status !== 204) {
    // RFC 7009: 200 even for already-revoked. Treat any non-2xx as informational only.
    const text = await res.text().catch(() => "");
    throw new Error(`Token revocation failed (${res.status}): ${text}`);
  }
}

/** Helper for callers that want the full expiry timestamp. */
export function computeExpiresAt(expiresInSeconds: number | undefined): string | null {
  if (!expiresInSeconds || expiresInSeconds <= 0) return null;
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}
