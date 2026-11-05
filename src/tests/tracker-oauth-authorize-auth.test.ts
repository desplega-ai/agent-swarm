/**
 * Starting the Linear / Jira tracker OAuth flow is an admin action: the
 * resulting tokens land on the swarm-wide `default` authorization (and Jira
 * also persists the consenting account's cloudId). The authorize routes must
 * therefore sit behind the API bearer plus the `oauth-authorization.manage`
 * permission, while the provider callbacks stay public and state-bound.
 *
 * The test drives the real `handleCore` auth gate and the real tracker
 * handlers in-process, against a loopback mock token endpoint.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeDb, createAgent, createUser, getDbClient, initDb } from "../be/db";
import { getOAuthTokens, storeOAuthTokens, upsertOAuthApp } from "../be/db-queries/oauth";
import { type IdentityActor, mintSessionToken, mintToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleTrackers } from "../http/trackers";
import { getPathSegments } from "../http/utils";
import { getJiraMetadata, updateJiraMetadata } from "../jira/metadata";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-tracker-oauth-authorize-auth.sqlite";
const API_KEY = "example-tracker-authorize-api-key";
const LEAD_ID = "aaaa9200-0000-4000-8000-000000000001";
const WORKER_ID = "aaaa9200-0000-4000-8000-000000000002";
const ACTOR: IdentityActor = { kind: "operator", id: "tracker-oauth-authorize-auth-test" };

// Token value A is what the swarm holds; B is what the mock provider issues.
const TOKEN_A = { linear: "example-linear-token-a", jira: "example-jira-token-a" } as const;
const TOKEN_B = { linear: "example-linear-token-b", jira: "example-jira-token-b" } as const;
const CLOUD_A = { cloudId: "cloud-a", siteUrl: "https://site-a.example.test" };
const CLOUD_B = { cloudId: "cloud-b", siteUrl: "https://site-b.example.test" };

type Provider = "linear" | "jira";

let providerServer: ReturnType<typeof Bun.serve>;
let providerBase = "";
let appServer: Server;
let appBase = "";
let userId = "";
let userToken = "";
let leadSessionToken = "";
let workerSessionToken = "";

const ENV_KEYS = [
  "LINEAR_CLIENT_ID",
  "LINEAR_DISABLE",
  "LINEAR_ENABLED",
  "JIRA_CLIENT_ID",
  "JIRA_DISABLE",
  "JIRA_ENABLED",
] as const;
const savedEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

function appServerFor(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    if (await handleTrackers(req, res, getPathSegments(req.url || ""))) return;
    res.writeHead(404);
    res.end("not found");
  });
}

async function seedDefaultAuthorizations(): Promise<void> {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  for (const provider of ["linear", "jira"] as const) {
    await storeOAuthTokens(provider, {
      accessToken: TOKEN_A[provider],
      refreshToken: `${TOKEN_A[provider]}-refresh`,
      expiresAt: future,
      scope: "read",
    });
  }
  await updateJiraMetadata(CLOUD_A);
}

/** Run the full authorize → provider consent → callback dance as `headers`. */
async function runOAuthDance(provider: Provider, headers: Record<string, string>) {
  const authorize = await originalFetch(`${appBase}/api/trackers/${provider}/authorize`, {
    headers,
    redirect: "manual",
  });
  const location = authorize.headers.get("location");
  const state = location ? new URL(location).searchParams.get("state") : null;
  let callbackStatus: number | null = null;
  if (state) {
    // The provider sends the browser back with a code and the state; no bearer.
    const callback = await originalFetch(
      `${appBase}/api/trackers/${provider}/callback?code=example-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    callbackStatus = callback.status;
    await callback.text();
  } else {
    await authorize.text();
  }
  return { authorizeStatus: authorize.status, state, callbackStatus };
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.LINEAR_CLIENT_ID = "example-linear-client";
  process.env.JIRA_CLIENT_ID = "example-jira-client";
  for (const key of ["LINEAR_DISABLE", "LINEAR_ENABLED", "JIRA_DISABLE", "JIRA_ENABLED"]) {
    delete process.env[key];
  }

  await unlink(TEST_DB_PATH).catch(() => {});
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "tracker-lead", isLead: true, status: "idle" });
  await createAgent({ id: WORKER_ID, name: "tracker-worker", isLead: false, status: "idle" });
  const user = await createUser({ name: "Tracker Admin", email: "tracker-admin@example.test" });
  userId = user.id;
  userToken = (await mintToken(user.id, "tracker-admin", ACTOR)).plaintext;
  // Per-agent session tokens: the shared swarm key alone resolves to the operator.
  leadSessionToken = (await mintSessionToken(LEAD_ID, crypto.randomUUID(), 60_000)).plaintext;
  workerSessionToken = (await mintSessionToken(WORKER_ID, crypto.randomUUID(), 60_000)).plaintext;

  providerServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const provider = url.pathname.split("/")[1] as Provider;
      if (url.pathname.endsWith("/token") && (provider === "linear" || provider === "jira")) {
        await req.text();
        return Response.json({
          access_token: TOKEN_B[provider],
          refresh_token: `${TOKEN_B[provider]}-refresh`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read write",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  providerBase = `http://localhost:${providerServer.port}`;

  appServer = appServerFor();
  appBase = `http://localhost:${await listenOnFreePort(appServer)}`;

  // The tracker post-processing calls fixed provider hosts (Linear GraphQL for
  // the bot user id, Atlassian accessible-resources for the cloudId). Answer
  // them locally; everything else goes to the real fetch.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === "api.linear.app") {
      return Response.json({ data: { viewer: { id: "bot-b", organization: { id: "org-b" } } } });
    }
    if (url.host === "api.atlassian.com" && url.pathname.endsWith("/accessible-resources")) {
      return Response.json([{ id: CLOUD_B.cloudId, url: CLOUD_B.siteUrl, name: "b", scopes: [] }]);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  for (const provider of ["linear", "jira"] as const) {
    await upsertOAuthApp(provider, {
      clientId: `example-${provider}-client`,
      clientSecret: `example-${provider}-client-secret`,
      authorizeUrl: `${providerBase}/${provider}/authorize`,
      tokenUrl: `${providerBase}/${provider}/token`,
      redirectUri: `${appBase}/api/trackers/${provider}/callback`,
      scopes: "read,write",
    });
  }
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  appServer.close();
  await providerServer.stop(true);
  closeDb();
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
});

beforeEach(async () => {
  await seedDefaultAuthorizations();
});

describe("tracker OAuth authorize requires an admin bearer", () => {
  test("an anonymous caller cannot rebind the Linear default authorization", async () => {
    const dance = await runOAuthDance("linear", {});
    const tokens = await getOAuthTokens("linear");
    expect({ authorizeStatus: dance.authorizeStatus, accessToken: tokens?.accessToken }).toEqual({
      authorizeStatus: 401,
      accessToken: TOKEN_A.linear,
    });
  });

  test("an anonymous caller cannot rebind the Jira default authorization or cloudId", async () => {
    const dance = await runOAuthDance("jira", {});
    const tokens = await getOAuthTokens("jira");
    const meta = await getJiraMetadata();
    expect({
      authorizeStatus: dance.authorizeStatus,
      accessToken: tokens?.accessToken,
      cloudId: meta.cloudId,
      siteUrl: meta.siteUrl,
    }).toEqual({
      authorizeStatus: 401,
      accessToken: TOKEN_A.jira,
      cloudId: CLOUD_A.cloudId,
      siteUrl: CLOUD_A.siteUrl,
    });
  });

  test("a non-lead agent is refused", async () => {
    for (const provider of ["linear", "jira"] as const) {
      const res = await originalFetch(`${appBase}/api/trackers/${provider}/authorize`, {
        headers: { Authorization: `Bearer ${workerSessionToken}` },
        redirect: "manual",
      });
      expect(res.status).toBe(403);
      await res.text();
    }
  });

  test("the lead agent can still start the flow (302 to the provider)", async () => {
    const res = await originalFetch(`${appBase}/api/trackers/linear/authorize`, {
      headers: { Authorization: `Bearer ${leadSessionToken}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toStartWith(`${providerBase}/linear/authorize?`);
  });

  test("an admin completes the dance; the callback stays public and lands the new grant", async () => {
    const linear = await runOAuthDance("linear", { Authorization: `Bearer ${API_KEY}` });
    expect(linear).toMatchObject({ authorizeStatus: 302, callbackStatus: 200 });
    expect((await getOAuthTokens("linear"))?.accessToken).toBe(TOKEN_B.linear);

    const jira = await runOAuthDance("jira", { Authorization: `Bearer ${API_KEY}` });
    expect(jira).toMatchObject({ authorizeStatus: 302, callbackStatus: 200 });
    expect((await getOAuthTokens("jira"))?.accessToken).toBe(TOKEN_B.jira);
    expect((await getJiraMetadata()).cloudId).toBe(CLOUD_B.cloudId);
  });

  test("format=json returns the consent URL and records the initiating user", async () => {
    for (const provider of ["linear", "jira"] as const) {
      const res = await originalFetch(`${appBase}/api/trackers/${provider}/authorize?format=json`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authorizeUrl: string };
      expect(body.authorizeUrl).toStartWith(`${providerBase}/${provider}/authorize?`);
      const state = new URL(body.authorizeUrl).searchParams.get("state");
      const pending = await getDbClient().get<{ userId: string | null; flow: string }>(
        "SELECT userId, flow FROM oauth_pending WHERE state = ?",
        [state],
      );
      expect(pending).toEqual({ userId, flow: "tracker" });
    }
  });
});
