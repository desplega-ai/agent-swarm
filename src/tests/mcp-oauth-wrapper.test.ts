import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
          client_secret: "issued-secret",
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
    expect(res.client_secret).toBe("issued-secret");
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
      clientSecret: "secret-xyz",
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
    expect(params.get("client_secret")).toBe("secret-xyz");
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
