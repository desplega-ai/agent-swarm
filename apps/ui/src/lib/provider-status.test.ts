import { describe, expect, test } from "bun:test";
import type {
  OAuthAppSummary,
  OAuthAuthorization,
  ScriptConnection,
  SwarmConfig,
} from "../api/types";
import { INTEGRATIONS } from "./integrations-catalog";
import {
  deriveProviderStatus,
  isProviderInUse,
  OAUTH_ONLY_TOOLS,
  type ProviderStatusInputs,
} from "./provider-status";

function row(key: string): SwarmConfig {
  return {
    id: `test-${key}`,
    scope: "global",
    scopeId: null,
    key,
    value: `value-${key}`,
    isSecret: false,
    envPath: null,
    description: null,
    createdAt: "2026-11-04T00:00:00.000Z",
    lastUpdatedAt: "2026-11-04T00:00:00.000Z",
    encrypted: false,
    exportToEnv: true,
  };
}

function authorization(status: OAuthAuthorization["status"] = "active"): OAuthAuthorization {
  return {
    id: `auth-${status}`,
    label: "default",
    accountEmail: "taras@example.test",
    status,
    expiresAt: null,
    scope: null,
    hasRefreshToken: true,
    lastErrorMessage: null,
    lastRefreshedAt: null,
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  };
}

function app(provider: string, authorizations: OAuthAuthorization[] = []): OAuthAppSummary {
  return {
    id: `app-${provider}`,
    provider,
    clientId: `${provider}-client`,
    authorizeUrl: "https://example.test/authorize",
    tokenUrl: "https://example.test/token",
    redirectUri: "https://swarm.example.test/api/oauth/callback",
    scopes: ["read"],
    tokenAuthStyle: "body",
    tokenBodyFormat: "form",
    source: "curated-prefill",
    tokenStatus: "missing",
    authorizations,
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  };
}

function connection(slug: string, baseUrl: string): ScriptConnection {
  return {
    id: `conn-${slug}`,
    slug,
    displayName: null,
    kind: "openapi",
    baseUrl,
  } as ScriptConnection;
}

function byId(id: string) {
  const def = [...INTEGRATIONS, ...OAUTH_ONLY_TOOLS].find((candidate) => candidate.id === id);
  if (!def) throw new Error(`Missing tool: ${id}`);
  return def;
}

function inputs(partial: Partial<ProviderStatusInputs> = {}): ProviderStatusInputs {
  return { configs: [], presence: {}, oauthApps: [], scriptConnections: [], ...partial };
}

const LINEAR_KEYS = ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_SIGNING_SECRET"].map(row);

describe("deriveProviderStatus", () => {
  test("Linear with keys only: configured, no OAuth app", () => {
    const status = deriveProviderStatus(byId("linear"), inputs({ configs: LINEAR_KEYS }));
    expect(status).toEqual({
      configured: "configured",
      oauth: "none",
      accounts: 0,
      scriptConnections: 0,
    });
  });

  test("Linear with keys and the seeded OAuth app: oauth 'app'", () => {
    const status = deriveProviderStatus(
      byId("linear"),
      inputs({ configs: LINEAR_KEYS, oauthApps: [app("linear")] }),
    );
    expect(status.configured).toBe("configured");
    expect(status.oauth).toBe("app");
  });

  test("Linear with keys, app and an authorization: oauth 'authorized'", () => {
    const status = deriveProviderStatus(
      byId("linear"),
      inputs({ configs: LINEAR_KEYS, oauthApps: [app("linear", [authorization()])] }),
    );
    expect(status.oauth).toBe("authorized");
    expect(status.accounts).toBe(1);
  });

  test("a revoked or expired authorization does not count as authorized", () => {
    const status = deriveProviderStatus(
      byId("linear"),
      inputs({ oauthApps: [app("linear", [authorization("revoked"), authorization("expired")])] }),
    );
    expect(status.oauth).toBe("app");
    expect(status.accounts).toBe(0);
  });

  test("Gmail reads the google OAuth app only", () => {
    expect(deriveProviderStatus(byId("gmail"), inputs()).configured).toBe("none");
    const status = deriveProviderStatus(
      byId("gmail"),
      inputs({ oauthApps: [app("google", [authorization()]), app("microsoft")] }),
    );
    expect(status).toEqual({
      configured: "configured",
      oauth: "authorized",
      accounts: 1,
      scriptConnections: 0,
    });
    expect(
      deriveProviderStatus(byId("microsoft-365"), inputs({ oauthApps: [app("microsoft")] })).oauth,
    ).toBe("app");
  });

  test("GitHub reads GITHUB_TOKEN from the deploy env presence", () => {
    const none = deriveProviderStatus(byId("github"), inputs());
    expect(none.configured).toBe("none");
    expect(isProviderInUse(none)).toBe(false);
    const status = deriveProviderStatus(
      byId("github"),
      inputs({ presence: { GITHUB_TOKEN: true } }),
    );
    expect(status.configured).toBe("partial");
    expect(isProviderInUse(status)).toBe(true);
  });

  test("script connections count by the provider's API host", () => {
    const scriptConnections = [
      connection("github-acme", "https://api.github.com"),
      connection("tickets", "https://acme.atlassian.net"),
      connection("pricing", "https://pricing.example.test"),
    ];
    expect(
      deriveProviderStatus(byId("github"), inputs({ scriptConnections })).scriptConnections,
    ).toBe(1);
    expect(
      deriveProviderStatus(byId("jira"), inputs({ scriptConnections })).scriptConnections,
    ).toBe(1);
    expect(
      deriveProviderStatus(byId("sentry"), inputs({ scriptConnections })).scriptConnections,
    ).toBe(0);
    const sentry = deriveProviderStatus(byId("sentry"), inputs({ scriptConnections }));
    expect(isProviderInUse(sentry)).toBe(false);
  });
});
