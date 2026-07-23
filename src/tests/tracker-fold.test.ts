import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import {
  getAuthorizationById,
  getDefaultAuthorizationIdForProvider,
  getOAuthApp,
  getOAuthAppIdByProvider,
  listAuthorizationsForApp,
  upsertAuthorization,
  upsertOAuthApp,
} from "../be/db-queries/oauth";
import { handleOAuthCallback } from "../http/oauth-callback";
import { handleScriptConnections } from "../http/script-connections";
import { handleJiraTracker } from "../http/trackers/jira";
import { handleLinearTracker } from "../http/trackers/linear";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { getJiraMetadata } from "../jira/metadata";
import { getJiraAuthorizationUrl } from "../jira/oauth";
import { getLinearClient, resetLinearClient } from "../linear/client";
import { getLinearAuthorizationUrl } from "../linear/oauth";
import { forceRefreshAuthorizationOrThrow, onAuthorizationRefreshed } from "../oauth/ensure-token";

const TEST_DB_PATH = "./test-tracker-fold.sqlite";
const LEAD_ID = "bbbb9200-0000-4000-8000-000000000001";

// ─── Mock provider (token endpoint, rotation-configurable) ───────────────────

let providerServer: ReturnType<typeof Bun.serve>;
let providerBase = "";
let includeRefreshToken = true; // toggled to exercise rotation strictness

// ─── External-URL fetch interceptor ──────────────────────────────────────────
//
// The tracker post-processing hits hardcoded provider URLs (Atlassian
// accessible-resources, Linear GraphQL/revoke). Intercept ONLY those; delegate
// everything else (the localhost mock token endpoint) to the real fetch.

const originalFetch = globalThis.fetch;

function installFetchInterceptor(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://api.atlassian.com/oauth/token/accessible-resources") {
      return new Response(
        JSON.stringify([{ id: "cloud-xyz", url: "https://acme.atlassian.net", name: "acme" }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "https://api.linear.app/graphql") {
      return Response.json({
        data: { viewer: { id: "bot-user-1", organization: { id: "org-1" } } },
      });
    }
    if (url === "https://api.linear.app/oauth/revoke") {
      return new Response(null, { status: 200 });
    }
    return originalFetch(input as RequestInfo, init);
  }) as unknown as typeof fetch;
}

// ─── App-side dispatcher (real route handlers) ───────────────────────────────

function appDispatcher(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (await handleLinearTracker(req, res, pathSegments)) return;
    if (await handleJiraTracker(req, res, pathSegments)) return;
    if (await handleOAuthCallback(req, res, pathSegments, queryParams)) return;
    const agentId = (req.headers["x-agent-id"] as string | undefined) ?? undefined;
    if (await handleScriptConnections(req, res, pathSegments, queryParams, agentId)) return;
    res.writeHead(404);
    res.end("not found");
  });
}

let appServer: Server;
let appBase = "";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string): void {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

/** Seed a tracker OAuth app whose token endpoint is the localhost mock. */
function seedMockTrackerApp(provider: "linear" | "jira", scopeSeparator: string): string {
  upsertOAuthApp(provider, {
    clientId: `${provider}-client`,
    clientSecret: `${provider}-secret`,
    authorizeUrl: `${providerBase}/authorize`,
    tokenUrl: `${providerBase}/token`,
    redirectUri: `${appBase}/api/trackers/${provider}/callback`,
    scopes: "read,write",
    scopeSeparator,
    requiresRefreshTokenRotation: provider === "jira",
    ...(provider === "jira" ? { extraParams: { audience: "api.atlassian.com" } } : {}),
  });
  const appId = getOAuthAppIdByProvider(provider);
  if (!appId) throw new Error("seed failed");
  return appId;
}

function stateFromAuthorizeUrl(url: string): string {
  const state = new URL(url).searchParams.get("state");
  if (!state) throw new Error("no state on authorize URL");
  return state;
}

beforeAll(async () => {
  process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS = "true";
  setEnv("LINEAR_CLIENT_ID", "linear-client");
  setEnv("LINEAR_CLIENT_SECRET", "linear-secret");
  setEnv("JIRA_CLIENT_ID", "jira-client");
  setEnv("JIRA_CLIENT_SECRET", "jira-secret");
  delete process.env.LINEAR_DISABLE;
  delete process.env.JIRA_DISABLE;

  initDb(TEST_DB_PATH);
  createAgent({ id: LEAD_ID, name: "lead", isLead: true, status: "idle" });

  providerServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token") {
        const body: Record<string, unknown> = {
          access_token: `access-${Date.now()}-${Math.random()}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read write",
        };
        if (includeRefreshToken) body.refresh_token = "rotated-refresh-token";
        return Response.json(body);
      }
      return new Response("not found", { status: 404 });
    },
  });
  providerBase = `http://localhost:${providerServer.port}`;

  appServer = appDispatcher();
  appBase = `http://localhost:${await listen(appServer)}`;

  installFetchInterceptor();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  appServer.close();
  await providerServer.stop(true);
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

beforeEach(() => {
  includeRefreshToken = true;
  resetLinearClient();
  getDb().query("DELETE FROM oauth_authorizations").run();
  getDb().query("DELETE FROM oauth_pending").run();
  getDb().query("DELETE FROM oauth_apps").run();
});

afterEach(async () => {
  const { resetLinear } = await import("../linear/app");
  const { resetJira } = await import("../jira/app");
  resetLinear();
  resetJira();
});

describe("step-8: tracker fold onto the unified OAuth core", () => {
  test("initLinear seeds column-correct linear app (comma separator + keepAlive/actor metadata)", async () => {
    const { initLinear } = await import("../linear/app");
    expect(initLinear()).toBe(true);

    const app = getOAuthApp("linear");
    expect(app).toBeTruthy();
    expect(app?.scopeSeparator).toBe(",");
    expect(Boolean(app?.requiresRefreshTokenRotation)).toBe(false);
    const metadata = JSON.parse(app?.metadata || "{}");
    expect(metadata.actor).toBe("app");
    // keepAlive opts the (non-rotating) linear row into the keepalive job on a
    // fresh DB where migration 121's data-only backfill matched no rows.
    expect(metadata.keepAlive === true || metadata.keepAlive === 1).toBe(true);
  });

  test("initJira seeds column-correct jira app (space separator, rotation flag, audience param)", async () => {
    const webhookLifecycle = await import("../jira/webhook-lifecycle");
    // Neutralize the boot webhook-keepalive timer (untracked 10s setTimeout).
    const startSpy = spyOn(webhookLifecycle, "startJiraWebhookKeepalive").mockImplementation(
      () => {},
    );
    try {
      const { initJira } = await import("../jira/app");
      expect(initJira()).toBe(true);

      const app = getOAuthApp("jira");
      expect(app?.scopeSeparator).toBe(" ");
      expect(Boolean(app?.requiresRefreshTokenRotation)).toBe(true);
      expect(app?.extraParamsJson).toContain("api.atlassian.com");
    } finally {
      startSpy.mockRestore();
    }
  });

  test("linear authorize→callback wrapper lands tokens on the default authorization", async () => {
    const appId = seedMockTrackerApp("linear", ",");

    const authorizeUrl = await getLinearAuthorizationUrl();
    expect(authorizeUrl).toBeTruthy();
    // Pending row is keyed flow='tracker'.
    const state = stateFromAuthorizeUrl(authorizeUrl as string);
    const pending = getDb()
      .query("SELECT flow, label FROM oauth_pending WHERE state = ?")
      .get(state) as { flow: string; label: string } | null;
    expect(pending?.flow).toBe("tracker");
    expect(pending?.label).toBe("default");

    const res = await fetch(
      `${appBase}/api/trackers/linear/callback?code=auth-code&state=${state}`,
      {
        redirect: "manual",
      },
    );
    expect(res.status).toBe(200);

    const authorizations = listAuthorizationsForApp(appId);
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.label).toBe("default");
    expect(authorizations[0]?.status).toBe("active");
    expect(authorizations[0]?.accessToken).toContain("access-");
  });

  test("jira authorize→callback wrapper lands tokens AND resolves cloudId into metadata", async () => {
    const appId = seedMockTrackerApp("jira", " ");

    const authorizeUrl = await getJiraAuthorizationUrl();
    const state = stateFromAuthorizeUrl(authorizeUrl as string);

    const res = await fetch(`${appBase}/api/trackers/jira/callback?code=auth-code&state=${state}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(200);

    const authorizations = listAuthorizationsForApp(appId);
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.status).toBe("active");

    // cloudId post-processing (deferred from step-4) now runs in the unified
    // flow='tracker' branch.
    const meta = getJiraMetadata();
    expect(meta.cloudId).toBe("cloud-xyz");
    expect(meta.siteUrl).toBe("https://acme.atlassian.net");
  });

  test("jira refresh enforces rotation strictness — missing rotated refresh_token throws + marks refresh-failed", async () => {
    seedMockTrackerApp("jira", " ");
    const appId = getOAuthAppIdByProvider("jira") as string;
    const authorization = upsertAuthorization({
      appId,
      label: "default",
      accessToken: "stale-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      status: "active",
    });

    includeRefreshToken = false; // provider omits the rotated refresh token

    await expect(forceRefreshAuthorizationOrThrow(authorization.id)).rejects.toThrow();

    const after = getAuthorizationById(authorization.id);
    expect(after?.status).toBe("refresh-failed");
  });

  test("carve-out removed: upserting a 'linear' app via the generic /api/oauth-apps surface succeeds", async () => {
    const res = await fetch(`${appBase}/api/oauth-apps`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": LEAD_ID },
      body: JSON.stringify({
        provider: "linear",
        clientId: "generic-linear-client",
        clientSecret: "generic-linear-secret",
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenUrl: "https://api.linear.app/oauth/token",
        scopes: ["read", "write"],
      }),
    });
    // Formerly rejected with a 400 "reserved for dedicated tracker OAuth flows".
    expect(res.status).toBe(200);
    const body = (await res.text()).toLowerCase();
    expect(body).not.toContain("reserved");
    expect(getOAuthAppIdByProvider("linear")).toBeTruthy();
  });

  test("sweep-driven refresh invalidates the cached Linear SDK client + notifies listeners", async () => {
    // initLinear() registers the resetLinearClient refresh listener + seeds the
    // real linear app; override the token endpoint to the localhost mock.
    const { initLinear } = await import("../linear/app");
    expect(initLinear()).toBe(true);
    const appId = seedMockTrackerApp("linear", ",");

    const authorization = upsertAuthorization({
      appId,
      label: "default",
      accessToken: "initial-access",
      refreshToken: "linear-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      status: "active",
    });
    expect(getDefaultAuthorizationIdForProvider("linear")).toBe(authorization.id);

    // Prime the cached client.
    const before = getLinearClient();
    expect(before).toBeTruthy();

    // Independently observe the notification mechanism.
    const events: string[] = [];
    const unsubscribe = onAuthorizationRefreshed((e) => events.push(e.provider));

    // Simulate a background/sweep refresh.
    await forceRefreshAuthorizationOrThrow(authorization.id);

    unsubscribe();

    expect(events).toContain("linear");
    // The cached client was reset by initLinear's listener, so a fresh instance
    // (carrying the rotated token) is built on the next read.
    const after = getLinearClient();
    expect(after).not.toBe(before);
  });
});
