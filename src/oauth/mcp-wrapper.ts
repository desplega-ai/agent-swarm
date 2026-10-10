import * as oauth from "oauth4webapi";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";

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

// Deliberately does NOT match "invalid_client_metadata" (a distinct DCR-only
// error) — the `\b` boundary fails on the following underscore. Shared by
// every MCP OAuth call site (explicit /refresh route, automatic
// ensureMcpToken refresh, callback token exchange) that needs to decide
// whether a provider has disowned a stored DCR client.
export function isInvalidClientError(message: string): boolean {
  return /invalid_client\b/i.test(message);
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

export function publicEndpointSsrfOptions(): SsrfGuardOptions {
  // Fail closed: NODE_ENV is typically UNSET in the production image (Bun
  // does not default it), so only an explicit development/test environment —
  // or the explicit override flag — may fetch private/insecure endpoints.
  // Local dev entrypoints (`bun run dev:http` / `start:http`) set
  // NODE_ENV=development.
  const env = process.env.NODE_ENV;
  const dev =
    env === "development" || env === "test" || process.env.ALLOW_PRIVATE_NETWORK_URLS === "true";
  return {
    allowPrivateHosts: dev,
    allowInsecure: dev,
  };
}

function defaultSsrfOptions(): SsrfGuardOptions {
  return {
    allowPrivateHosts: isEnvFlagEnabled("MCP_OAUTH_ALLOW_PRIVATE_HOSTS", false),
    allowInsecure: process.env.NODE_ENV !== "production",
  };
}

// Every safeFetch call is bounded so a provider that accepts the connection
// and never responds can't hang indefinitely. This matters most for the
// calls made under `withAuthorizeFlowLock` (metadata discovery + DCR POST in
// mcp-oauth.ts) — an unbounded fetch there would block every subsequent
// /authorize for that connector+user behind the lock. 15s is generous for
// OAuth metadata/DCR/token-endpoint round trips while still bounding the
// lock hold time; token exchange, refresh, and revocation share the same
// default since none of them should legitimately take longer.
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

async function safeFetch(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  assertUrlSafe(url, defaultSsrfOptions());
  return fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
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

// ─── Token endpoint client authentication (RFC 6749 §2.3.1 / RFC 7591 §2) ────

/**
 * The three `token_endpoint_auth_method` values agent-swarm knows how to
 * apply at the token endpoint. Other RFC 7591 values (e.g. `private_key_jwt`)
 * are not supported by any MCP provider we've integrated with; they fall
 * back to the RFC 7591 §2 default below.
 */
export type TokenEndpointAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

const KNOWN_TOKEN_ENDPOINT_AUTH_METHODS: readonly TokenEndpointAuthMethod[] = [
  "client_secret_basic",
  "client_secret_post",
  "none",
];

/** RFC 7591 §2: "client_secret_basic" is the default when unspecified. */
export const DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD: TokenEndpointAuthMethod = "client_secret_basic";

/** Coerce a value we read back from a provider (or our own storage) to a known method, defaulting per RFC 7591 §2. */
export function normalizeTokenEndpointAuthMethod(
  value: string | null | undefined,
): TokenEndpointAuthMethod {
  return (KNOWN_TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(value ?? "")
    ? (value as TokenEndpointAuthMethod)
    : DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD;
}

export class UnsupportedTokenEndpointAuthMethodError extends Error {
  constructor(value: string, source: string) {
    super(
      `Authorization server ${source} token_endpoint_auth_method "${value}", which agent-swarm cannot perform. ` +
        `Supported methods: ${KNOWN_TOKEN_ENDPOINT_AUTH_METHODS.join(", ")}. ` +
        `Register a client manually via POST /api/mcp-oauth/:id/manual-client with a supported method.`,
    );
    this.name = "UnsupportedTokenEndpointAuthMethodError";
  }
}

/**
 * Resolve a method the authorization server stated EXPLICITLY. An omitted
 * value falls back to the RFC 7591 §2 default, but a present-and-unsupported
 * value (e.g. `private_key_jwt`) is an error rather than a silent downgrade:
 * coercing it to Basic would send credentials in a scheme the AS did not
 * select, contradicting "server wins" and failing later as invalid_client.
 */
export function resolveAdvertisedTokenEndpointAuthMethod(
  value: string | null | undefined,
  source: string,
): TokenEndpointAuthMethod {
  // An empty string is treated as "not stated", not as an unsupported method.
  // A provider that serializes the field empty has told us nothing, and the
  // DCR caller falls back to the method it requested (which the AS advertised)
  // rather than erroring. Failing here would break such a provider outright
  // for no safety gain, since we still authenticate the way it advertised.
  if (value == null || value === "") return DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD;
  if (!(KNOWN_TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(value)) {
    throw new UnsupportedTokenEndpointAuthMethodError(value, source);
  }
  return value as TokenEndpointAuthMethod;
}

/**
 * Read the method from a persisted client. Older rows predate this field and
 * used client_secret_post, so preserve that known-working behavior.
 */
export function authMethodForStoredClient(
  value: string | null | undefined,
): TokenEndpointAuthMethod {
  if (value == null || value === "") return "client_secret_post";
  return normalizeTokenEndpointAuthMethod(value);
}

/**
 * Pick the method to REQUEST during DCR from the AS's advertised
 * `token_endpoint_auth_methods_supported`. Prefers the RFC-preferred Basic
 * form, then body-post, then public (`none`); falls back to the RFC 7591 §2
 * default when the AS didn't advertise anything we recognize.
 */
export function selectDcrTokenEndpointAuthMethod(
  supportedMethods: string[] | undefined,
): TokenEndpointAuthMethod {
  // An empty advertised list is degenerate rather than a claim to support
  // nothing, so it takes the RFC 8414 omitted-value default. Only a non-empty
  // list containing nothing we can perform is a genuine incompatibility.
  if (!supportedMethods || supportedMethods.length === 0) {
    return DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD;
  }
  for (const method of KNOWN_TOKEN_ENDPOINT_AUTH_METHODS) {
    if (supportedMethods.includes(method)) return method;
  }
  // The AS advertised a list and none of it is something we can perform.
  // Defaulting to Basic here would register a client we can never authenticate.
  throw new UnsupportedTokenEndpointAuthMethodError(supportedMethods.join(", "), "advertises only");
}

/**
 * Serialize one credential component per `application/x-www-form-urlencoded`,
 * which RFC 6749 §2.3.1 requires before Base64-encoding the Basic header.
 * `encodeURIComponent` is NOT that algorithm: it emits `%20` for a space where
 * form encoding emits `+`, and it leaves `!'()*` unescaped.
 */
function formUrlEncodeComponent(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

/**
 * Redact every credential representation we actually transmitted from an
 * upstream error body before it can be logged, persisted, or reflected into a
 * redirect.
 *
 * `scrubSecrets` alone is not enough here: `registerVolatileSecret` ignores
 * values shorter than its minimum length, and RFC 7591 sets no floor on a
 * `client_secret`. A provider echoing a short secret, or the form-encoded
 * form of a longer one, would otherwise pass straight through.
 *
 * Every value is redacted in BOTH its raw and its form-encoded shape. Anything
 * we put in a `URLSearchParams` body travels percent-encoded (a token like
 * `a+b/c=` is sent as `a%2Bb%2Fc%3D`), so a provider that echoes its received
 * body back would otherwise leak the encoded form. Doing it here rather than
 * at each call site means a new sensitive field cannot forget one shape.
 */
function redactSentCredentials(text: string, sent: Array<string | null | undefined>): string {
  let out: string = scrubSecrets(text);
  for (const value of sent) {
    if (!value) continue;
    for (const shape of new Set([value, formUrlEncodeComponent(value)])) {
      out = out.split(shape).join("[REDACTED]");
    }
  }
  return out;
}

/**
 * Apply the client's registered auth method to a token-endpoint request.
 * Mutates `body` and `headers` in place so callers can build the rest of the
 * grant-specific params around it.
 *
 *   - client_secret_basic → Authorization: Basic header; no creds in body.
 *   - client_secret_post  → client_id/client_secret in the body; no header.
 *   - none (public client) → client_id only in the body; no secret anywhere.
 *
 * Returns every credential representation it put on the wire so the caller can
 * redact exactly what it sent, whatever the encoding or length.
 */
function applyClientAuthentication(
  method: TokenEndpointAuthMethod,
  clientId: string,
  clientSecret: string | null | undefined,
  body: URLSearchParams,
  headers: Record<string, string>,
): string[] {
  if (method === "client_secret_basic" && clientSecret) {
    const encodedSecret = formUrlEncodeComponent(clientSecret);
    const credentials = `${formUrlEncodeComponent(clientId)}:${encodedSecret}`;
    const encoded = Buffer.from(credentials).toString("base64");
    // The Base64 blob is itself a credential. Register it so a provider that
    // echoes the Authorization header back in an error body gets scrubbed.
    registerVolatileSecret(encoded, "mcp_oauth_basic_credential");
    headers.Authorization = `Basic ${encoded}`;
    return [clientSecret, encodedSecret, encoded, credentials];
  }

  // A public client must identify itself in the body, whatever method was
  // recorded for a client with no secret.
  body.set("client_id", clientId);
  if (method === "client_secret_post" && clientSecret) {
    body.set("client_secret", clientSecret);
    return [clientSecret, formUrlEncodeComponent(clientSecret)];
  }
  return [];
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
    const RESERVED = new Set([
      "response_type",
      "client_id",
      "redirect_uri",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
      "resource",
    ]);
    for (const [k, v] of Object.entries(input.extraParams)) {
      if (RESERVED.has(k.toLowerCase())) {
        console.warn(`[mcp-oauth] extraParams key "${k}" is reserved and skipped`);
        continue;
      }
      url.searchParams.set(k, v);
    }
  }

  return { url: url.toString(), state, codeVerifier, codeChallenge };
}

export interface ExchangeCodeInput {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string | null;
  tokenEndpointAuthMethod?: string | null;
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
  // A provider can echo a submitted credential back verbatim in an error body.
  // The thrown message is logged by the callback AND reflected into the
  // dashboard redirect as error_description, so redact before it can escape.
  if (input.clientSecret) registerVolatileSecret(input.clientSecret, "mcp_oauth_client_secret");

  const method = normalizeTokenEndpointAuthMethod(input.tokenEndpointAuthMethod);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    resource: input.resource,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const sentCredentials = applyClientAuthentication(
    method,
    input.clientId,
    input.clientSecret,
    body,
    headers,
  );

  const res = await safeFetch(input.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // The code and verifier are single-use but the exchange just failed, so
    // treat them as live. Both callback sinks (console.error and the dashboard
    // redirect's error_description) receive this message verbatim.
    throw new Error(
      `Token exchange failed (${res.status}): ${redactSentCredentials(text, [
        ...sentCredentials,
        input.code,
        input.codeVerifier,
      ])}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

export interface RefreshTokenInput {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string | null;
  tokenEndpointAuthMethod?: string | null;
  refreshToken: string;
  resource: string;
  scopes?: string[];
}

export async function refreshMcpToken(input: RefreshTokenInput): Promise<TokenResponse> {
  // A misbehaving/compromised provider can echo a submitted credential back
  // verbatim in an error body (e.g. "invalid client_secret: <value>"). Both
  // credentials we send are registered as volatile secrets so the scrub pass
  // below redacts any echo BEFORE the message is persisted to
  // lastErrorMessage or returned by the status endpoint.
  if (input.clientSecret) registerVolatileSecret(input.clientSecret, "mcp_oauth_client_secret");
  registerVolatileSecret(input.refreshToken, "mcp_oauth_refresh_token");

  const method = normalizeTokenEndpointAuthMethod(input.tokenEndpointAuthMethod);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    resource: input.resource,
  });
  if (input.scopes && input.scopes.length > 0) body.set("scope", input.scopes.join(" "));
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const sentCredentials = applyClientAuthentication(
    method,
    input.clientId,
    input.clientSecret,
    body,
    headers,
  );

  const res = await safeFetch(input.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Token refresh failed (${res.status}): ${redactSentCredentials(text, [
        ...sentCredentials,
        input.refreshToken,
      ])}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

export interface RevokeInput {
  revocationUrl: string;
  token: string;
  tokenTypeHint?: "access_token" | "refresh_token";
  clientId: string;
  clientSecret?: string | null;
  tokenEndpointAuthMethod?: string | null;
}

export async function revokeMcpToken(input: RevokeInput): Promise<void> {
  // Same exposure as the exchange path: the caller logs this error verbatim.
  if (input.clientSecret) registerVolatileSecret(input.clientSecret, "mcp_oauth_client_secret");
  registerVolatileSecret(input.token, "mcp_oauth_revoked_token");

  const method = normalizeTokenEndpointAuthMethod(input.tokenEndpointAuthMethod);
  const body = new URLSearchParams({ token: input.token });
  if (input.tokenTypeHint) body.set("token_type_hint", input.tokenTypeHint);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const sentCredentials = applyClientAuthentication(
    method,
    input.clientId,
    input.clientSecret,
    body,
    headers,
  );

  const res = await safeFetch(input.revocationUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });
  if (!res.ok && res.status !== 200 && res.status !== 204) {
    // RFC 7009: 200 even for already-revoked. Treat any non-2xx as informational only.
    const text = await res.text().catch(() => "");
    throw new Error(
      `Token revocation failed (${res.status}): ${redactSentCredentials(text, [
        ...sentCredentials,
        input.token,
      ])}`,
    );
  }
}

/** Helper for callers that want the full expiry timestamp. */
export function computeExpiresAt(expiresInSeconds: number | undefined): string | null {
  if (!expiresInSeconds || expiresInSeconds <= 0) return null;
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}
