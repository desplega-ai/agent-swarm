import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  exchangeAuthorizationCode,
  type OAuthProviderConfig,
  performTokenRefreshRequest,
  refreshTokenGrant,
} from "../oauth/wrapper";
import { setFakeDnsAnswer } from "./fake-dns";

// No lookup leaves the process: `auth.public.test` resolves to a public address
// (reserved test name), `rebind.public.test` to loopback.
setFakeDnsAnswer("rebind.public.test", ["127.0.0.1"]);

const originalFetch = globalThis.fetch;
const savedEnv = {
  NODE_ENV: process.env.NODE_ENV,
  ALLOW_PRIVATE_NETWORK_URLS: process.env.ALLOW_PRIVATE_NETWORK_URLS,
};

type Seen = { host: string; hostname: string; body: string | null };

/**
 * A fetch stand-in that records every request and answers from `route`.
 * Requests are routed by the Host header (an address-pinned request keeps the
 * original name there).
 */
function installFetch(route: (host: string) => Response): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const host = new Headers(init?.headers).get("host") ?? url.host;
    seen.push({
      host,
      hostname: url.hostname,
      body: typeof init?.body === "string" ? init.body : null,
    });
    return route(host);
  }) as typeof fetch;
  return seen;
}

const isLoopback = (s: Seen) =>
  s.hostname === "127.0.0.1" || s.host.startsWith("127.0.0.1") || s.host === "rebind.public.test";

const tokens = () => Response.json({ access_token: "new-access", token_type: "Bearer" });

function config(tokenUrl: string): OAuthProviderConfig {
  return {
    provider: "token-guard-test",
    clientId: "client-id",
    clientSecret: "client-secret-value",
    authorizeUrl: "https://auth.public.test/authorize",
    tokenUrl,
    redirectUri: "https://swarm.public.test/callback",
    scopes: [],
  };
}

const exchange = (tokenUrl: string) =>
  exchangeAuthorizationCode(config(tokenUrl), {
    code: "the-code",
    codeVerifier: "the-verifier",
    redirectUri: "https://swarm.public.test/callback",
  });

// The three requests that POST the client secret to the token endpoint.
const tokenRequests: Array<[string, (tokenUrl: string) => Promise<unknown>]> = [
  ["exchangeAuthorizationCode", exchange],
  ["refreshTokenGrant", (tokenUrl) => refreshTokenGrant(config(tokenUrl), "the-refresh-token")],
  [
    "performTokenRefreshRequest",
    (tokenUrl) => performTokenRefreshRequest(config(tokenUrl), "the-refresh-token"),
  ],
];

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

describe.each(tokenRequests)("%s token endpoint request", (_name, send) => {
  test("control: a public token endpoint receives the client secret", async () => {
    const seen = installFetch(tokens);
    await send("https://auth.public.test/token");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.host).toBe("auth.public.test");
    expect(seen[0]?.body).toContain("client_secret=client-secret-value");
  });

  test("does not send the client secret to a name that resolves to a loopback address", async () => {
    const seen = installFetch(tokens);
    await expect(send("https://rebind.public.test/token")).rejects.toThrow();
    expect(seen.filter(isLoopback)).toEqual([]);
  });
});

test("code exchange does not follow a redirect to a name that resolves to a loopback address", async () => {
  const seen = installFetch((host) =>
    host === "auth.public.test"
      ? new Response(null, {
          status: 307,
          headers: { location: "https://rebind.public.test/token" },
        })
      : tokens(),
  );
  await expect(exchange("https://auth.public.test/token")).rejects.toThrow();
  expect(seen.filter(isLoopback)).toEqual([]);
});
