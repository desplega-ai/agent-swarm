import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { attemptRemoteRevocation, discoverOAuthApp } from "../http/script-connections";
import { captureIdentity } from "../oauth/identity-capture";
import type { OAuthApp } from "../tracker/types";
import { setFakeDnsAnswer } from "./fake-dns";

// No lookup leaves the process: `auth.public.test` resolves to a public address
// (reserved test name), `rebind.public.test` to loopback.
setFakeDnsAnswer("rebind.public.test", ["127.0.0.1"]);

const originalFetch = globalThis.fetch;
const savedEnv = {
  NODE_ENV: process.env.NODE_ENV,
  ALLOW_PRIVATE_NETWORK_URLS: process.env.ALLOW_PRIVATE_NETWORK_URLS,
};

type Seen = { host: string; hostname: string; authorization: string | null; body: string | null };

/**
 * A fetch stand-in that records every request and answers from `route`.
 * Requests are routed by the Host header (an address-pinned request keeps the
 * original name there). Every caller here passes `redirect: "manual"`.
 */
function installFetch(route: (host: string, url: URL) => Response): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = new Headers(init?.headers);
    const host = headers.get("host") ?? url.host;
    seen.push({
      host,
      hostname: url.hostname,
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return route(host, url);
  }) as typeof fetch;
  return seen;
}

const isLoopback = (s: Seen) =>
  s.hostname === "127.0.0.1" || s.host.startsWith("127.0.0.1") || s.host === "rebind.public.test";

function oauthApp(revocationUrl: string): OAuthApp {
  return {
    id: crypto.randomUUID(),
    provider: "guard-test",
    displayName: null,
    clientId: "client-id",
    clientSecret: "client-secret-value",
    clientSecretEncrypted: false,
    authorizeUrl: "https://auth.public.test/authorize",
    tokenUrl: "https://auth.public.test/token",
    revocationUrl,
    userinfoUrl: null,
    redirectUri: "https://swarm.public.test/callback",
    scopes: "",
    scopeSeparator: " ",
    tokenAuthStyle: "body",
    tokenBodyFormat: "form",
    requiresRefreshTokenRotation: false,
    extraParamsJson: null,
    source: "manual",
    mcpServerId: null,
    metadata: "{}",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const metadata = {
  authorization_endpoint: "https://auth.public.test/authorize",
  token_endpoint: "https://auth.public.test/token",
};

beforeAll(() => {
  process.env.NODE_ENV = "production";
  delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("OAuth identity capture outbound request", () => {
  test("control: a public userinfo endpoint receives the bearer", async () => {
    const seen = installFetch(() => Response.json({ email: "user@example.com" }));
    const identity = await captureIdentity({
      userinfoUrl: "https://auth.public.test/userinfo",
      accessToken: "live-access-token",
    });
    expect(identity?.accountEmail).toBe("user@example.com");
    expect(seen.map((s) => s.authorization)).toEqual(["Bearer live-access-token"]);
  });

  test("does not send the bearer to a name that resolves to a loopback address", async () => {
    const seen = installFetch(() => Response.json({ email: "internal@example.com" }));
    const identity = await captureIdentity({
      userinfoUrl: "https://rebind.public.test/userinfo",
      accessToken: "live-access-token",
    });
    expect(seen.filter(isLoopback)).toEqual([]);
    expect(identity).toBeNull();
  });
});

describe("OAuth token revocation outbound request", () => {
  test("control: a public revocation endpoint receives the request", async () => {
    const seen = installFetch(() => new Response(null, { status: 200 }));
    await expect(
      attemptRemoteRevocation(oauthApp("https://auth.public.test/revoke"), "live-access-token"),
    ).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toContain("client_secret=client-secret-value");
  });

  test("does not send the client secret to a name that resolves to a loopback address", async () => {
    const seen = installFetch(() => new Response(null, { status: 200 }));
    await attemptRemoteRevocation(
      oauthApp("https://rebind.public.test/revoke"),
      "live-access-token",
    );
    expect(seen.filter(isLoopback)).toEqual([]);
  });
});

describe("OAuth app discovery outbound requests", () => {
  test("control: a public issuer's metadata is fetched and parsed", async () => {
    const seen = installFetch(() => Response.json(metadata));
    const discovered = await discoverOAuthApp("https://auth.public.test");
    expect(discovered.tokenUrl).toBe("https://auth.public.test/token");
    expect(seen.length).toBeGreaterThan(0);
  });

  test("does not connect to an issuer name that resolves to a loopback address", async () => {
    const seen = installFetch(() => Response.json(metadata));
    await expect(discoverOAuthApp("https://rebind.public.test")).rejects.toThrow();
    expect(seen.filter(isLoopback)).toEqual([]);
  });

  test("does not follow a redirect to a name that resolves to a loopback address", async () => {
    const seen = installFetch((host) =>
      host === "auth.public.test"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://rebind.public.test/metadata" },
          })
        : Response.json(metadata),
    );
    await expect(discoverOAuthApp("https://auth.public.test")).rejects.toThrow();
    expect(seen.filter(isLoopback)).toEqual([]);
  });
});
