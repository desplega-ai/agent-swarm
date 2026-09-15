import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assertUrlSafe,
  authMethodForStoredClient,
  buildAuthorizeUrl,
  computeExpiresAt,
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  exchangeCodeForTokens,
  normalizeTokenEndpointAuthMethod,
  refreshMcpToken,
  registerClient,
  revokeMcpToken,
  selectDcrTokenEndpointAuthMethod,
} from "../oauth/mcp-wrapper";

// ─── SSRF guard ──────────────────────────────────────────────────────────────

describe("assertUrlSafe (SSRF guard)", () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevAllow = process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS;

  beforeEach(() => {
    delete process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS;
    process.env.NODE_ENV = "production"; // enforce https strictness unless allowInsecure
  });
  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevAllow === undefined) delete process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS;
    else process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS = prevAllow;
  });

  test("allows public https", () => {
    expect(() => assertUrlSafe("https://mcp.notion.com/.well-known/…")).not.toThrow();
  });

  test("rejects localhost by default", () => {
    expect(() => assertUrlSafe("https://localhost/x")).toThrow(/loopback/i);
  });

  test("rejects 127.0.0.1 by default", () => {
    expect(() => assertUrlSafe("https://127.0.0.1/x")).toThrow(/private IPv4/i);
  });

  test("rejects 169.254 link-local by default", () => {
    expect(() => assertUrlSafe("https://169.254.169.254/latest/meta-data")).toThrow(
      /private IPv4/i,
    );
  });

  test("rejects RFC1918 10.x, 192.168.x, 172.16-31", () => {
    expect(() => assertUrlSafe("https://10.0.0.1/x")).toThrow(/private IPv4/i);
    expect(() => assertUrlSafe("https://192.168.1.1/x")).toThrow(/private IPv4/i);
    expect(() => assertUrlSafe("https://172.16.0.1/x")).toThrow(/private IPv4/i);
    expect(() => assertUrlSafe("https://172.31.255.255/x")).toThrow(/private IPv4/i);
  });

  test("allows 172.32+ (outside RFC1918 block)", () => {
    expect(() => assertUrlSafe("https://172.32.0.1/x")).not.toThrow();
  });

  test("rejects IPv6 loopback and link-local", () => {
    expect(() => assertUrlSafe("https://[::1]/x")).toThrow(/private IPv6/i);
    expect(() => assertUrlSafe("https://[fe80::1]/x")).toThrow(/private IPv6/i);
    expect(() => assertUrlSafe("https://[fc00::1]/x")).toThrow(/private IPv6/i);
  });

  test("rejects non-http(s) schemes", () => {
    expect(() => assertUrlSafe("file:///etc/passwd")).toThrow(/unsupported protocol/i);
    expect(() => assertUrlSafe("ftp://example.com/")).toThrow(/unsupported protocol/i);
  });

  test("rejects http:// in production", () => {
    expect(() => assertUrlSafe("http://example.com/")).toThrow(/insecure/i);
  });

  test("allows http:// when allowInsecure=true", () => {
    expect(() => assertUrlSafe("http://example.com/", { allowInsecure: true })).not.toThrow();
  });

  test("allows private hosts when allowPrivateHosts=true", () => {
    expect(() => assertUrlSafe("https://localhost/x", { allowPrivateHosts: true })).not.toThrow();
    expect(() => assertUrlSafe("https://10.0.0.1/x", { allowPrivateHosts: true })).not.toThrow();
  });

  test("rejects obviously invalid URL", () => {
    expect(() => assertUrlSafe("not a url")).toThrow(/Invalid URL/);
  });
});

// ─── PKCE / Authorize URL ────────────────────────────────────────────────────

describe("buildAuthorizeUrl (PKCE S256, RFC 8707)", () => {
  test("includes resource= and code_challenge_method=S256", async () => {
    const result = await buildAuthorizeUrl({
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientId: "client-xyz",
      redirectUri: "https://swarm.example.com/callback",
      scopes: ["read", "write"],
      resource: "https://mcp.example.com/",
    });

    const u = new URL(result.url);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("client-xyz");
    expect(u.searchParams.get("redirect_uri")).toBe("https://swarm.example.com/callback");
    expect(u.searchParams.get("scope")).toBe("read write");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(result.codeChallenge);
    expect(u.searchParams.get("state")).toBe(result.state);
    expect(u.searchParams.get("resource")).toBe("https://mcp.example.com/");
    // verifier should be a URL-safe token of reasonable length
    expect(result.codeVerifier.length).toBeGreaterThanOrEqual(32);
  });

  test("custom state is respected", async () => {
    const result = await buildAuthorizeUrl({
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientId: "c",
      redirectUri: "https://swarm.example.com/cb",
      scopes: [],
      resource: "https://mcp.example.com/",
      state: "my-state",
    });
    expect(result.state).toBe("my-state");
    expect(new URL(result.url).searchParams.get("state")).toBe("my-state");
  });

  test("omits scope param when scopes is empty", async () => {
    const result = await buildAuthorizeUrl({
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientId: "c",
      redirectUri: "https://swarm.example.com/cb",
      scopes: [],
      resource: "https://mcp.example.com/",
    });
    expect(new URL(result.url).searchParams.has("scope")).toBe(false);
  });

  test("extraParams are appended to the authorize URL (e.g. BigQuery offline access)", async () => {
    const result = await buildAuthorizeUrl({
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientId: "bq-client",
      redirectUri: "https://swarm.example.com/callback",
      scopes: ["https://www.googleapis.com/auth/bigquery"],
      resource: "https://bigquery.googleapis.com/",
      extraParams: { access_type: "offline", prompt: "consent" },
    });

    const u = new URL(result.url);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  test("extraParams cannot override reserved OAuth params (redirect_uri, state, etc.)", async () => {
    const result = await buildAuthorizeUrl({
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientId: "c",
      redirectUri: "https://swarm.example.com/cb",
      scopes: ["read"],
      resource: "https://mcp.example.com/",
      state: "safe-state",
      extraParams: {
        redirect_uri: "https://evil.com",
        state: "injected",
        code_challenge: "malicious",
        code_challenge_method: "plain",
        response_type: "token",
        client_id: "attacker",
        scope: "admin",
        resource: "https://evil.com/",
      },
    });
    const u = new URL(result.url);
    expect(u.searchParams.get("redirect_uri")).toBe("https://swarm.example.com/cb");
    expect(u.searchParams.get("state")).toBe("safe-state");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("c");
    expect(u.searchParams.get("resource")).toBe("https://mcp.example.com/");
    // Attacker values must not have landed
    const challenge = u.searchParams.get("code_challenge");
    expect(challenge).not.toBeNull();
    expect(challenge).not.toBe("malicious");
    expect(u.searchParams.get("scope")).toBe("read");
  });

  test("mixed-case reserved keys in extraParams are rejected (case-insensitive guard)", async () => {
    const result = await buildAuthorizeUrl({
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientId: "c",
      redirectUri: "https://swarm.example.com/cb",
      scopes: ["read"],
      resource: "https://mcp.example.com/",
      state: "safe-state",
      extraParams: {
        Redirect_Uri: "https://evil.example",
        STATE: "evil-state",
        Code_Challenge: "malicious-challenge",
        SCOPE: "admin",
      },
    });
    const u = new URL(result.url);
    // Attacker mixed-case keys must NOT appear in the URL
    expect(u.searchParams.get("Redirect_Uri")).toBeNull();
    expect(u.searchParams.get("STATE")).toBeNull();
    expect(u.searchParams.get("Code_Challenge")).toBeNull();
    expect(u.searchParams.get("SCOPE")).toBeNull();
    // Core params must retain their original legitimate values
    expect(u.searchParams.get("redirect_uri")).toBe("https://swarm.example.com/cb");
    expect(u.searchParams.get("state")).toBe("safe-state");
    expect(u.searchParams.get("scope")).toBe("read");
  });

  test("null/undefined extraParams leaves URL unchanged (no blast radius for existing servers)", async () => {
    const withExtra = await buildAuthorizeUrl({
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientId: "c",
      redirectUri: "https://swarm.example.com/cb",
      scopes: ["read"],
      resource: "https://mcp.example.com/",
      extraParams: { access_type: "offline" },
      state: "fixed-state",
    });

    const withoutExtra = await buildAuthorizeUrl({
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientId: "c",
      redirectUri: "https://swarm.example.com/cb",
      scopes: ["read"],
      resource: "https://mcp.example.com/",
      state: "fixed-state",
    });

    const uWith = new URL(withExtra.url);
    const uWithout = new URL(withoutExtra.url);
    expect(uWith.searchParams.has("access_type")).toBe(true);
    expect(uWithout.searchParams.has("access_type")).toBe(false);
    // Core params are identical
    expect(uWith.searchParams.get("client_id")).toBe(uWithout.searchParams.get("client_id"));
    expect(uWith.searchParams.get("state")).toBe(uWithout.searchParams.get("state"));
  });
});

// ─── Discovery (PRMD + AS metadata) ──────────────────────────────────────────

describe("discoverProtectedResourceMetadata (RFC 9728)", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("returns metadata from .well-known", async () => {
    globalThis.fetch = async (url: string | URL | Request) => {
      const href = url.toString();
      if (href === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return new Response(
          JSON.stringify({
            resource: "https://mcp.example.com/",
            authorization_servers: ["https://as.example.com"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const meta = await discoverProtectedResourceMetadata("https://mcp.example.com/");
    expect(meta).not.toBeNull();
    expect(meta!.authorization_servers).toEqual(["https://as.example.com"]);
  });

  test("falls back to WWW-Authenticate probe", async () => {
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const href = url.toString();
      if (href === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return new Response("gone", { status: 404 });
      }
      if (init?.method === "HEAD" && href === "https://mcp.example.com/") {
        return new Response("", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.com/oauth-meta"',
          },
        });
      }
      if (href === "https://mcp.example.com/oauth-meta") {
        return new Response(
          JSON.stringify({
            resource: "https://mcp.example.com/",
            authorization_servers: ["https://as.example.com"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const meta = await discoverProtectedResourceMetadata("https://mcp.example.com/");
    expect(meta).not.toBeNull();
    expect(meta!.authorization_servers).toEqual(["https://as.example.com"]);
  });

  test("returns null when both probes fail", async () => {
    globalThis.fetch = async () => new Response("not found", { status: 404 });
    const meta = await discoverProtectedResourceMetadata("https://mcp.example.com/");
    expect(meta).toBeNull();
  });
});

describe("discoverAuthorizationServerMetadata (RFC 8414)", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("prefers oauth-authorization-server over openid-configuration", async () => {
    globalThis.fetch = async (url: string | URL | Request) => {
      const href = url.toString();
      if (href === "https://as.example.com/.well-known/oauth-authorization-server") {
        return new Response(
          JSON.stringify({
            issuer: "https://as.example.com",
            authorization_endpoint: "https://as.example.com/authorize",
            token_endpoint: "https://as.example.com/token",
            registration_endpoint: "https://as.example.com/register",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const meta = await discoverAuthorizationServerMetadata("https://as.example.com/");
    expect(meta.token_endpoint).toBe("https://as.example.com/token");
    expect(meta.registration_endpoint).toBe("https://as.example.com/register");
  });

  test("falls back to openid-configuration", async () => {
    globalThis.fetch = async (url: string | URL | Request) => {
      const href = url.toString();
      if (href === "https://as.example.com/.well-known/oauth-authorization-server") {
        return new Response("nope", { status: 404 });
      }
      if (href === "https://as.example.com/.well-known/openid-configuration") {
        return new Response(
          JSON.stringify({
            issuer: "https://as.example.com",
            authorization_endpoint: "https://as.example.com/oauth2/authorize",
            token_endpoint: "https://as.example.com/oauth2/token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const meta = await discoverAuthorizationServerMetadata("https://as.example.com/");
    expect(meta.authorization_endpoint).toBe("https://as.example.com/oauth2/authorize");
  });

  test("throws when both well-knowns 404", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 404 });
    await expect(discoverAuthorizationServerMetadata("https://as.example.com/")).rejects.toThrow();
  });
});

// ─── DCR (RFC 7591) ──────────────────────────────────────────────────────────

describe("registerClient (RFC 7591 DCR)", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("POSTs JSON and returns client credentials", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          client_id: "issued-id",
          client_secret: "example-issued-secret",
          client_id_issued_at: 1700000000,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const res = await registerClient("https://as.example.com/register", {
      client_name: "agent-swarm",
      redirect_uris: ["https://swarm.example.com/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "client_secret_basic",
    });

    expect(res.client_id).toBe("issued-id");
    expect(res.client_secret).toBe("example-issued-secret");
    expect(capturedBody).toBeTruthy();
    expect(JSON.parse(capturedBody!).client_name).toBe("agent-swarm");
  });

  test("throws on non-2xx response with body snippet", async () => {
    globalThis.fetch = async () =>
      new Response('{"error":"invalid_client_metadata"}', { status: 400 });

    await expect(
      registerClient("https://as.example.com/register", {
        client_name: "x",
        redirect_uris: ["https://swarm.example.com/cb"],
      }),
    ).rejects.toThrow(/Dynamic client registration failed/);
  });

  test("attaches a bounded AbortSignal so a non-responding registration endpoint can't hang the caller forever", async () => {
    let capturedSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Response(JSON.stringify({ client_id: "x" }), { status: 201 });
    };

    await registerClient("https://as.example.com/register", {
      client_name: "x",
      redirect_uris: ["https://swarm.example.com/cb"],
    });

    // Every safeFetch call (metadata discovery, DCR, token exchange,
    // refresh, revocation) gets a default timeout — without it, a provider
    // that accepts the connection and never responds would hold the
    // per-connector authorize-flow lock indefinitely.
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
  });
});

// ─── Token exchange + refresh + revoke ───────────────────────────────────────

describe("exchangeCodeForTokens", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("POSTs form body with PKCE verifier + resource, parses JSON response", async () => {
    let capturedBody: string | undefined;
    let capturedUrl = "";
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          access_token: "at-1",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rt-1",
          scope: "read",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const res = await exchangeCodeForTokens({
      tokenUrl: "https://as.example.com/token",
      clientId: "client-xyz",
      clientSecret: "example-secret-xyz",
      tokenEndpointAuthMethod: "client_secret_post",
      redirectUri: "https://swarm.example.com/callback",
      code: "authcode-1",
      codeVerifier: "verifier-1",
      resource: "https://mcp.example.com/",
    });

    expect(capturedUrl).toBe("https://as.example.com/token");
    const params = new URLSearchParams(capturedBody ?? "");
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("authcode-1");
    expect(params.get("code_verifier")).toBe("verifier-1");
    expect(params.get("resource")).toBe("https://mcp.example.com/");
    expect(params.get("client_secret")).toBe("example-secret-xyz");
    expect(res.access_token).toBe("at-1");
  });

  test("throws on non-2xx with status + body", async () => {
    globalThis.fetch = async () => new Response('{"error":"invalid_grant"}', { status: 400 });

    await expect(
      exchangeCodeForTokens({
        tokenUrl: "https://as.example.com/token",
        clientId: "c",
        redirectUri: "https://swarm.example.com/cb",
        code: "c",
        codeVerifier: "v",
        resource: "https://mcp.example.com/",
      }),
    ).rejects.toThrow(/Token exchange failed \(400\)/);
  });
});

describe("refreshMcpToken", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("sends refresh_token grant with resource param", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ access_token: "new-at", expires_in: 900 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const res = await refreshMcpToken({
      tokenUrl: "https://as.example.com/token",
      clientId: "c",
      refreshToken: "rt-abc",
      resource: "https://mcp.example.com/",
      scopes: ["read"],
    });

    const params = new URLSearchParams(capturedBody ?? "");
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rt-abc");
    expect(params.get("resource")).toBe("https://mcp.example.com/");
    expect(params.get("scope")).toBe("read");
    expect(res.access_token).toBe("new-at");
  });

  test("throws on non-2xx", async () => {
    globalThis.fetch = async () => new Response('{"error":"invalid_grant"}', { status: 400 });

    await expect(
      refreshMcpToken({
        tokenUrl: "https://as.example.com/token",
        clientId: "c",
        refreshToken: "rt",
        resource: "https://mcp.example.com/",
      }),
    ).rejects.toThrow(/Token refresh failed \(400\)/);
  });

  test("scrubs an echoed client_secret/refresh_token from the thrown error body", async () => {
    const clientSecret = "example-super-secret-client-value-123456";
    const refreshToken = "example-super-secret-refresh-value-654321";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: "invalid_client",
          error_description: `client_secret ${clientSecret} rejected for refresh_token ${refreshToken}`,
        }),
        { status: 401 },
      );

    let thrown: Error | undefined;
    try {
      await refreshMcpToken({
        tokenUrl: "https://as.example.com/token",
        clientId: "c",
        clientSecret,
        refreshToken,
        resource: "https://mcp.example.com/",
      });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).not.toContain(clientSecret);
    expect(thrown!.message).not.toContain(refreshToken);
    expect(thrown!.message).toMatch(/\[REDACTED:mcp_oauth_client_secret]/);
    expect(thrown!.message).toMatch(/\[REDACTED:mcp_oauth_refresh_token]/);
  });
});

describe("revokeMcpToken (RFC 7009)", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("POSTs token + client_id to revocation endpoint", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response("", { status: 200 });
    };

    await revokeMcpToken({
      revocationUrl: "https://as.example.com/revoke",
      token: "t-1",
      clientId: "c",
      tokenTypeHint: "refresh_token",
      tokenEndpointAuthMethod: "client_secret_post",
    });

    const params = new URLSearchParams(capturedBody ?? "");
    expect(params.get("token")).toBe("t-1");
    expect(params.get("client_id")).toBe("c");
    expect(params.get("token_type_hint")).toBe("refresh_token");
  });

  test("non-2xx throws (except documented 200/204)", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    await expect(
      revokeMcpToken({
        revocationUrl: "https://as.example.com/revoke",
        token: "t",
        clientId: "c",
      }),
    ).rejects.toThrow(/Token revocation failed \(500\)/);
  });
});

// ─── Token endpoint client authentication (RFC 6749 §2.3.1 / RFC 7591 §2) ────

describe("selectDcrTokenEndpointAuthMethod", () => {
  test("prefers client_secret_basic when the AS advertises it", () => {
    expect(
      selectDcrTokenEndpointAuthMethod(["client_secret_post", "client_secret_basic", "none"]),
    ).toBe("client_secret_basic");
  });

  test("falls back to client_secret_post when basic isn't advertised", () => {
    expect(selectDcrTokenEndpointAuthMethod(["client_secret_post", "none"])).toBe(
      "client_secret_post",
    );
  });

  test("falls back to none when only public-client auth is advertised", () => {
    expect(selectDcrTokenEndpointAuthMethod(["none"])).toBe("none");
  });

  test("an explicitly empty advertised list takes the RFC 8414 default, it is not an incompatibility", () => {
    // Degenerate serialization, not a claim to support nothing. Erroring here
    // would break such a provider outright for no safety gain.
    expect(selectDcrTokenEndpointAuthMethod([])).toBe("client_secret_basic");
  });

  test("throws when the AS advertises only methods we cannot perform", () => {
    // Silently registering a Basic client against an AS that offers only
    // private_key_jwt produces a client we can never authenticate, surfacing
    // later as an opaque invalid_client. Fail early and actionably instead.
    expect(() => selectDcrTokenEndpointAuthMethod(["private_key_jwt"])).toThrow(/cannot perform/);
  });

  test("defaults to client_secret_basic when metadata is absent (RFC 7591 §2)", () => {
    expect(selectDcrTokenEndpointAuthMethod(undefined)).toBe("client_secret_basic");
    expect(selectDcrTokenEndpointAuthMethod([])).toBe("client_secret_basic");
  });
});

describe("normalizeTokenEndpointAuthMethod", () => {
  test("passes through known values", () => {
    expect(normalizeTokenEndpointAuthMethod("client_secret_basic")).toBe("client_secret_basic");
    expect(normalizeTokenEndpointAuthMethod("client_secret_post")).toBe("client_secret_post");
    expect(normalizeTokenEndpointAuthMethod("none")).toBe("none");
  });

  test("defaults missing/unknown values to client_secret_basic, not body-post", () => {
    expect(normalizeTokenEndpointAuthMethod(undefined)).toBe("client_secret_basic");
    expect(normalizeTokenEndpointAuthMethod(null)).toBe("client_secret_basic");
    expect(normalizeTokenEndpointAuthMethod("")).toBe("client_secret_basic");
    expect(normalizeTokenEndpointAuthMethod("private_key_jwt")).toBe("client_secret_basic");
  });
});

describe("authMethodForStoredClient", () => {
  test("preserves legacy body-post behavior when the field is absent", () => {
    expect(authMethodForStoredClient(undefined)).toBe("client_secret_post");
    expect(authMethodForStoredClient(null)).toBe("client_secret_post");
    expect(authMethodForStoredClient("")).toBe("client_secret_post");
  });
});

describe("token-endpoint client authentication is applied per the registered method", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  async function captureExchange(
    tokenEndpointAuthMethod: string | null | undefined,
    creds: { clientId?: string; clientSecret?: string } = {},
  ) {
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? "";
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ access_token: "at-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    await exchangeCodeForTokens({
      tokenUrl: "https://as.example.com/token",
      clientId: creds.clientId ?? "client-xyz",
      clientSecret: creds.clientSecret ?? "example-secret-xyz",
      tokenEndpointAuthMethod,
      redirectUri: "https://swarm.example.com/callback",
      code: "authcode-1",
      codeVerifier: "verifier-1",
      resource: "https://mcp.example.com/",
    });
    return { params: new URLSearchParams(capturedBody), headers: capturedHeaders };
  }

  test("client_secret_basic → Authorization: Basic header, no creds in the body", async () => {
    const { params, headers } = await captureExchange("client_secret_basic");
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("client-xyz:example-secret-xyz").toString("base64")}`,
    );
    expect(params.get("client_id")).toBeNull();
    expect(params.get("client_secret")).toBeNull();
  });

  test("client_secret_post → client_id/client_secret in the body, no Authorization header", async () => {
    const { params, headers } = await captureExchange("client_secret_post");
    expect(headers.Authorization).toBeUndefined();
    expect(params.get("client_id")).toBe("client-xyz");
    expect(params.get("client_secret")).toBe("example-secret-xyz");
  });

  test("none → client_id only in the body, no secret anywhere", async () => {
    const { params, headers } = await captureExchange("none");
    expect(headers.Authorization).toBeUndefined();
    expect(params.get("client_id")).toBe("client-xyz");
    expect(params.get("client_secret")).toBeNull();
  });

  test("Basic credentials are form-urlencoded per RFC 6749 §2.3.1, not encodeURIComponent", async () => {
    // A space form-encodes to "+", not "%20", and !'()* must be escaped.
    // Getting this wrong sends a different secret than the AS stored, which
    // surfaces as an opaque invalid_client at exchange, refresh and revoke.
    const clientId = "client id!";
    const clientSecret = "se cret*(a)";
    const { headers } = await captureExchange("client_secret_basic", { clientId, clientSecret });

    const decoded = Buffer.from(
      (headers.Authorization ?? "").replace(/^Basic /, ""),
      "base64",
    ).toString();
    // `*` is intentionally literal: the urlencoded serializer preserves
    // alphanumerics plus *-._ and encodes everything else.
    expect(decoded).toBe("client+id%21:se+cret*%28a%29");
    expect(decoded).not.toContain("%20");
  });

  test("a SHORT client secret is redacted even though registerVolatileSecret ignores it", async () => {
    // registerVolatileSecret drops values under its minimum length, and RFC
    // 7591 sets no floor on a client_secret, so redaction cannot rely on it.
    const shortSecret = "s3cr3t";
    globalThis.fetch = async () =>
      new Response(`{"error":"invalid_client","detail":"bad secret ${shortSecret}"}`, {
        status: 401,
      });

    await exchangeCodeForTokens({
      tokenUrl: "https://as.example.com/token",
      clientId: "client-xyz",
      clientSecret: shortSecret,
      tokenEndpointAuthMethod: "client_secret_post",
      redirectUri: "https://swarm.example.com/callback",
      code: "authcode-1",
      codeVerifier: "verifier-1",
      resource: "https://mcp.example.com/",
    }).catch((err: Error) => {
      expect(err.message).toContain("Token exchange failed (401)");
      expect(err.message).not.toContain(shortSecret);
    });
  });

  test("the code, verifier and encoded credential forms are redacted too", async () => {
    const secret = "se cret with spaces";
    const encodedSecret = new URLSearchParams({ v: secret }).toString().slice(2);
    const code = "authcode-echoed";
    const verifier = "verifier-echoed";
    globalThis.fetch = async () =>
      new Response(`{"detail":"${encodedSecret} ${code} ${verifier}"}`, { status: 400 });

    await exchangeCodeForTokens({
      tokenUrl: "https://as.example.com/token",
      clientId: "client-xyz",
      clientSecret: secret,
      tokenEndpointAuthMethod: "client_secret_basic",
      redirectUri: "https://swarm.example.com/callback",
      code,
      codeVerifier: verifier,
      resource: "https://mcp.example.com/",
    }).catch((err: Error) => {
      expect(err.message).not.toContain(encodedSecret);
      expect(err.message).not.toContain(code);
      expect(err.message).not.toContain(verifier);
      expect(err.message).not.toContain(secret);
    });
  });

  test("form-encoded code and verifier are redacted when they contain reserved characters", async () => {
    // A base64ish code like "a+b/c=" travels as "a%2Bb%2Fc%3D". Redacting only
    // the raw value leaves the echoed body untouched. Earlier tests used
    // URL-safe values, so they could not catch this.
    const code = "a+b/c=";
    const verifier = "v+e/r=";
    const encode = (v: string) => new URLSearchParams({ v }).toString().slice(2);
    globalThis.fetch = async () =>
      new Response(`{"detail":"code=${encode(code)}&code_verifier=${encode(verifier)}"}`, {
        status: 400,
      });

    await exchangeCodeForTokens({
      tokenUrl: "https://as.example.com/token",
      clientId: "client-xyz",
      clientSecret: "example-secret-xyz",
      tokenEndpointAuthMethod: "client_secret_post",
      redirectUri: "https://swarm.example.com/callback",
      code,
      codeVerifier: verifier,
      resource: "https://mcp.example.com/",
    }).catch((err: Error) => {
      expect(err.message).not.toContain(encode(code));
      expect(err.message).not.toContain(encode(verifier));
      expect(err.message).not.toContain(code);
      expect(err.message).not.toContain(verifier);
    });
  });

  test("a form-encoded refresh token is redacted on a failed refresh", async () => {
    const refreshToken = "example-rt+slash/eq=";
    const encoded = new URLSearchParams({ v: refreshToken }).toString().slice(2);
    globalThis.fetch = async () =>
      new Response(`{"detail":"refresh_token=${encoded}"}`, { status: 400 });

    await refreshMcpToken({
      tokenUrl: "https://as.example.com/token",
      clientId: "client-xyz",
      clientSecret: "example-secret-xyz",
      tokenEndpointAuthMethod: "client_secret_post",
      refreshToken,
      resource: "https://mcp.example.com/",
    }).catch((err: Error) => {
      expect(err.message).toContain("Token refresh failed (400)");
      expect(err.message).not.toContain(encoded);
      expect(err.message).not.toContain(refreshToken);
    });
  });

  test("a form-encoded revoked token is redacted on a failed revocation", async () => {
    const token = "example-tok+slash/eq=";
    const encoded = new URLSearchParams({ v: token }).toString().slice(2);
    globalThis.fetch = async () => new Response(`{"detail":"token=${encoded}"}`, { status: 400 });

    await revokeMcpToken({
      revocationUrl: "https://as.example.com/revoke",
      token,
      clientId: "client-xyz",
      clientSecret: "example-secret-xyz",
      tokenEndpointAuthMethod: "client_secret_post",
    }).catch((err: Error) => {
      expect(err.message).toContain("Token revocation failed (400)");
      expect(err.message).not.toContain(encoded);
      expect(err.message).not.toContain(token);
    });
  });

  test("an upstream error body echoing the client secret is scrubbed before it is thrown", async () => {
    // The callback logs this message AND reflects it into the dashboard
    // redirect as error_description, so an echoed credential would escape.
    const secret = "s" + "k-echoed-secret-value-1234567890";
    globalThis.fetch = async () =>
      new Response(`{"error":"invalid_client","detail":"bad client_secret: ${secret}"}`, {
        status: 401,
      });

    await expect(
      exchangeCodeForTokens({
        tokenUrl: "https://as.example.com/token",
        clientId: "client-xyz",
        clientSecret: secret,
        tokenEndpointAuthMethod: "client_secret_basic",
        redirectUri: "https://swarm.example.com/callback",
        code: "authcode-1",
        codeVerifier: "verifier-1",
        resource: "https://mcp.example.com/",
      }),
    ).rejects.toThrow(/Token exchange failed \(401\)/);

    await exchangeCodeForTokens({
      tokenUrl: "https://as.example.com/token",
      clientId: "client-xyz",
      clientSecret: secret,
      tokenEndpointAuthMethod: "client_secret_basic",
      redirectUri: "https://swarm.example.com/callback",
      code: "authcode-1",
      codeVerifier: "verifier-1",
      resource: "https://mcp.example.com/",
    }).catch((err: Error) => {
      expect(err.message).not.toContain(secret);
    });
  });

  test("a revocation error body echoing the token is scrubbed before it is thrown", async () => {
    const token = "example-rt-echoed-refresh-token-0987654321";
    globalThis.fetch = async () => new Response(`{"error":"bad token: ${token}"}`, { status: 400 });

    await revokeMcpToken({
      revocationUrl: "https://as.example.com/revoke",
      token,
      clientId: "client-xyz",
      clientSecret: "example-secret-xyz",
      tokenEndpointAuthMethod: "client_secret_post",
    }).catch((err: Error) => {
      expect(err.message).toContain("Token revocation failed (400)");
      expect(err.message).not.toContain(token);
    });
  });

  test("missing/unknown value defaults to client_secret_basic, never the old body-post behavior", async () => {
    for (const missing of [undefined, null, "some-unknown-method"]) {
      const { params, headers } = await captureExchange(missing);
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from("client-xyz:example-secret-xyz").toString("base64")}`,
      );
      expect(params.get("client_id")).toBeNull();
      expect(params.get("client_secret")).toBeNull();
    }
  });

  test("a public client recorded as basic identifies itself in the body", async () => {
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? "";
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ access_token: "at-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await exchangeCodeForTokens({
      tokenUrl: "https://as.example.com/token",
      clientId: "public-client",
      clientSecret: null,
      tokenEndpointAuthMethod: "client_secret_basic",
      redirectUri: "https://swarm.example.com/callback",
      code: "authcode-1",
      codeVerifier: "verifier-1",
      resource: "https://mcp.example.com/",
    });

    const params = new URLSearchParams(capturedBody);
    expect(capturedHeaders.Authorization).toBeUndefined();
    expect(params.get("client_id")).toBe("public-client");
    expect(params.get("client_secret")).toBeNull();
  });

  test("refreshMcpToken applies the same rule on the refresh_token grant", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? "";
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ access_token: "new-at" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await refreshMcpToken({
      tokenUrl: "https://as.example.com/token",
      clientId: "client-xyz",
      clientSecret: "example-secret-xyz",
      tokenEndpointAuthMethod: "client_secret_basic",
      refreshToken: "rt-abc",
      resource: "https://mcp.example.com/",
    });

    const params = new URLSearchParams(capturedBody);
    expect(capturedHeaders.Authorization).toBe(
      `Basic ${Buffer.from("client-xyz:example-secret-xyz").toString("base64")}`,
    );
    expect(params.get("client_id")).toBeNull();
    expect(params.get("client_secret")).toBeNull();
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rt-abc");
  });
});

// ─── computeExpiresAt ────────────────────────────────────────────────────────

describe("computeExpiresAt", () => {
  test("returns null for undefined / zero / negative", () => {
    expect(computeExpiresAt(undefined)).toBeNull();
    expect(computeExpiresAt(0)).toBeNull();
    expect(computeExpiresAt(-60)).toBeNull();
  });

  test("returns ISO timestamp N seconds in the future", () => {
    const before = Date.now();
    const iso = computeExpiresAt(3600);
    const after = Date.now();
    expect(iso).not.toBeNull();
    const t = new Date(iso!).getTime();
    expect(t).toBeGreaterThanOrEqual(before + 3600_000 - 100);
    expect(t).toBeLessThanOrEqual(after + 3600_000 + 100);
  });
});
