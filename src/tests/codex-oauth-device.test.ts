import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { decryptSecret, encryptSecret, getEncryptionKey } from "../be/crypto";
import {
  closeDb,
  getDbClient,
  getKv,
  getSwarmConfigs,
  initDb,
  upsertKv,
  upsertSwarmConfig,
} from "../be/db";
import type { OnboardingState } from "../be/onboarding";
import { handleCodexOAuthDevice } from "../http/codex-oauth-device";
import { handleCore } from "../http/core";
import { handleOnboarding } from "../http/onboarding";
import { getPathSegments, parseQueryParams } from "../http/utils";
import {
  DeviceCodeNotEnabledError,
  pollDeviceToken,
  requestDeviceCode,
} from "../providers/codex-oauth/device";
import { resetFetchForTesting, setFetchForTesting } from "../providers/codex-oauth/flow";
import { listenOnFreePort } from "./test-net";

const API_KEY = "example-codex-device-test-key";
const DEVICE_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

let server: Server;
let baseUrl = "";
let fetchImpl: typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function accountToken(accountId: string): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
}

async function request(path: string, method = "POST"): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(),
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}

async function startFlow(): Promise<{
  flowId: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: string;
}> {
  const response = await request("/api/codex-oauth/device");
  expect(response.status).toBe(200);
  return (await response.json()) as {
    flowId: string;
    userCode: string;
    intervalSeconds: number;
    expiresAt: string;
  };
}

beforeAll(async () => {
  initDb(":memory:");
  server = createServer(async (req, res) => {
    if (await handleCore(req, res, req.headers["x-agent-id"] as string | undefined, API_KEY)) {
      return;
    }
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (await handleOnboarding(req, res, pathSegments, queryParams)) return;
    if (await handleCodexOAuthDevice(req, res, pathSegments, queryParams)) return;
    res.writeHead(404).end();
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  resetFetchForTesting();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM kv_entries");
  await getDbClient().run("DELETE FROM swarm_config");
  fetchImpl = async () => {
    throw new Error("Unexpected fetch");
  };
  setFetchForTesting(((input, init) => fetchImpl(input, init)) as typeof fetch);
});

afterEach(() => resetFetchForTesting());

describe("Codex device provider", () => {
  test("parses the usercode alias and string polling interval", async () => {
    let requestBody: Record<string, unknown> | undefined;
    fetchImpl = (async (input, init) => {
      expect(String(input)).toBe(DEVICE_CODE_URL);
      expect(new Headers(init?.headers).get("originator")).toBe("agent-swarm");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        device_auth_id: "device-auth-1",
        usercode: "ABCD-EFGH",
        interval: " 7 ",
      });
    }) as typeof fetch;

    await expect(requestDeviceCode()).resolves.toEqual({
      deviceAuthId: "device-auth-1",
      userCode: "ABCD-EFGH",
      intervalSeconds: 7,
    });
    expect(requestBody?.client_id).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  });

  test("maps pending, failed, and successful token responses", async () => {
    const responses = [
      new Response(null, { status: 403 }),
      new Response(null, { status: 500 }),
      jsonResponse({ authorization_code: "authorization-code", code_verifier: "code-verifier" }),
    ];
    fetchImpl = (async (input) => {
      expect(String(input)).toBe(DEVICE_TOKEN_URL);
      return responses.shift()!;
    }) as typeof fetch;

    await expect(pollDeviceToken("device", "code")).resolves.toEqual({ type: "pending" });
    await expect(pollDeviceToken("device", "code")).resolves.toEqual({
      type: "failed",
      status: 500,
    });
    await expect(pollDeviceToken("device", "code")).resolves.toEqual({
      type: "success",
      authorizationCode: "authorization-code",
      codeVerifier: "code-verifier",
    });
  });

  test("treats a 404 token response as pending", async () => {
    fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;
    await expect(pollDeviceToken("device", "code")).resolves.toEqual({ type: "pending" });
  });

  test("uses the default interval and reports disabled device login", async () => {
    const responses = [
      jsonResponse({ device_auth_id: "device-default", user_code: "DEFAULT" }),
      new Response(null, { status: 404 }),
    ];
    fetchImpl = (async () => responses.shift()!) as typeof fetch;

    await expect(requestDeviceCode()).resolves.toMatchObject({ intervalSeconds: 5 });
    await expect(requestDeviceCode()).rejects.toBeInstanceOf(DeviceCodeNotEnabledError);
  });
});

describe("Codex device HTTP routes", () => {
  test("completes the flow, saves the first free slot, and updates onboarding", async () => {
    await request("/api/onboarding", "GET");
    await upsertSwarmConfig({
      scope: "global",
      key: "codex_oauth",
      value: JSON.stringify({ legacy: true }),
      isSecret: true,
    });
    await upsertSwarmConfig({
      scope: "global",
      key: "codex_oauth_2",
      value: JSON.stringify({ occupied: true }),
      isSecret: true,
    });
    await getDbClient().run(
      `INSERT INTO swarm_config (
         id, scope, scopeId, key, value, isSecret, envPath, description,
         createdAt, lastUpdatedAt, encrypted
       ) VALUES (?, 'global', NULL, 'UNRELATED_SECRET', 'invalid-ciphertext', 1, NULL, NULL, ?, ?, 1)`,
      [crypto.randomUUID(), new Date().toISOString(), new Date().toISOString()],
    );

    fetchImpl = (async (input, init) => {
      const url = String(input);
      if (url === DEVICE_CODE_URL) {
        return jsonResponse({
          device_auth_id: "device-auth-full",
          user_code: "FULL-CODE",
          interval: 5,
        });
      }
      if (url === DEVICE_TOKEN_URL) {
        return jsonResponse({
          authorization_code: "full-auth-code",
          code_verifier: "full-verifier",
        });
      }
      if (url === TOKEN_URL) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
        return jsonResponse({
          access_token: accountToken("account-full"),
          refresh_token: "refresh-full",
          expires_in: 3600,
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;

    const started = await startFlow();
    expect(Number.isNaN(Date.parse(started.expiresAt))).toBe(false);
    const encrypted = await getKv("codex-oauth-device", started.flowId);
    expect(encrypted?.value).not.toContain("device-auth-full");

    const poll = await request(`/api/codex-oauth/device/${started.flowId}/poll`);
    expect(await poll.json()).toEqual({ status: "complete", slot: 1 });

    const saved = await getSwarmConfigs({ scope: "global", key: "codex_oauth_1" });
    expect(saved).toHaveLength(1);
    const credentials = JSON.parse(saved[0]!.value) as Record<string, unknown>;
    expect(credentials).toMatchObject({
      accountId: "account-full",
      refresh: "refresh-full",
    });
    expect(Object.keys(credentials).sort()).toEqual(["access", "accountId", "expires", "refresh"]);
    const onboarding = await getSwarmConfigs({ scope: "global", key: "onboarding_state" });
    const state = JSON.parse(onboarding[0]!.value) as OnboardingState;
    expect(state.steps.ai).toMatchObject({ status: "done", method: "codex_device" });
  });

  test("throttles upstream polling to the requested interval", async () => {
    let pollCalls = 0;
    fetchImpl = (async (input) => {
      if (String(input) === DEVICE_CODE_URL) {
        return jsonResponse({
          device_auth_id: "device-throttle",
          user_code: "THROTTLE",
          interval: 30,
        });
      }
      if (String(input) === DEVICE_TOKEN_URL) {
        pollCalls += 1;
        return new Response(null, { status: 403 });
      }
      throw new Error("Unexpected fetch");
    }) as typeof fetch;

    const started = await startFlow();
    expect(await (await request(`/api/codex-oauth/device/${started.flowId}/poll`)).json()).toEqual({
      status: "pending",
    });
    expect(await (await request(`/api/codex-oauth/device/${started.flowId}/poll`)).json()).toEqual({
      status: "pending",
    });
    expect(pollCalls).toBe(1);
  });

  test("keeps a lease through token exchange and credential storage", async () => {
    let pollCalls = 0;
    let exchangeCalls = 0;
    let releaseExchange!: () => void;
    let markExchangeStarted!: () => void;
    const exchangeReleased = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve;
    });

    fetchImpl = (async (input) => {
      const url = String(input);
      if (url === DEVICE_CODE_URL) {
        return jsonResponse({
          device_auth_id: "device-concurrent",
          user_code: "CONCURRENT",
          interval: 0.001,
        });
      }
      if (url === DEVICE_TOKEN_URL) {
        pollCalls += 1;
        if (pollCalls > 1) return new Response(null, { status: 500 });
        return jsonResponse({
          authorization_code: "concurrent-auth-code",
          code_verifier: "concurrent-verifier",
        });
      }
      if (url === TOKEN_URL) {
        exchangeCalls += 1;
        markExchangeStarted();
        await exchangeReleased;
        return jsonResponse({
          access_token: accountToken("account-concurrent"),
          refresh_token: "refresh-concurrent",
          expires_in: 3600,
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;

    const started = await startFlow();
    const path = `/api/codex-oauth/device/${started.flowId}/poll`;
    const firstPoll = request(path);
    await exchangeStarted;
    await Bun.sleep(5);

    const secondResponse = await request(path);
    const secondBody = await secondResponse.json();
    const callsBeforeRelease = { pollCalls, exchangeCalls };
    const entry = await getKv("codex-oauth-device", started.flowId);
    const state = JSON.parse(decryptSecret(String(entry!.value), getEncryptionKey())) as Record<
      string,
      unknown
    >;
    state.pollLeaseExpiresAt = Date.now() - 1;
    await upsertKv({
      namespace: "codex-oauth-device",
      key: started.flowId,
      value: encryptSecret(JSON.stringify(state), getEncryptionKey()),
      valueType: "string",
      expiresAt: Number(state.expiresAt),
    });
    releaseExchange();
    const firstBody = await (await firstPoll).json();

    expect(secondBody).toEqual({ status: "pending" });
    expect(callsBeforeRelease).toEqual({ pollCalls: 1, exchangeCalls: 1 });
    expect(firstBody).toEqual({ status: "complete", slot: 0 });
    expect(await (await request(path)).json()).toEqual({ status: "complete", slot: 0 });
    expect(await getSwarmConfigs({ scope: "global", key: "codex_oauth_0" })).toHaveLength(1);
  });

  test("reclaims an expired polling lease", async () => {
    let pollCalls = 0;
    fetchImpl = (async (input) => {
      if (String(input) === DEVICE_CODE_URL) {
        return jsonResponse({
          device_auth_id: "device-recover",
          user_code: "RECOVER",
          interval: 5,
        });
      }
      if (String(input) === DEVICE_TOKEN_URL) {
        pollCalls += 1;
        return new Response(null, { status: 403 });
      }
      throw new Error("Unexpected fetch");
    }) as typeof fetch;

    const started = await startFlow();
    const entry = await getKv("codex-oauth-device", started.flowId);
    const state = JSON.parse(decryptSecret(String(entry!.value), getEncryptionKey())) as Record<
      string,
      unknown
    >;
    state.lastPolledAt = Date.now() - 10_000;
    state.pollLeaseId = crypto.randomUUID();
    state.pollLeaseExpiresAt = Date.now() - 1;
    await upsertKv({
      namespace: "codex-oauth-device",
      key: started.flowId,
      value: encryptSecret(JSON.stringify(state), getEncryptionKey()),
      valueType: "string",
      expiresAt: Number(state.expiresAt),
    });

    expect(await (await request(`/api/codex-oauth/device/${started.flowId}/poll`)).json()).toEqual({
      status: "pending",
    });
    expect(pollCalls).toBe(1);

    const recovered = await getKv("codex-oauth-device", started.flowId);
    const recoveredState = JSON.parse(
      decryptSecret(String(recovered!.value), getEncryptionKey()),
    ) as Record<string, unknown>;
    expect(recoveredState.pollLeaseId).toBeNull();
    expect(recoveredState.pollLeaseExpiresAt).toBeNull();
  });

  test("returns expired after the encrypted flow TTL passes", async () => {
    await request("/api/onboarding", "GET");
    const onboardingBefore = await getSwarmConfigs({ scope: "global", key: "onboarding_state" });
    fetchImpl = (async (input) => {
      if (String(input) === DEVICE_CODE_URL) {
        return jsonResponse({
          device_auth_id: "device-expired",
          user_code: "EXPIRED",
          interval: 5,
        });
      }
      throw new Error("Polling should not reach OpenAI");
    }) as typeof fetch;

    const started = await startFlow();
    const entry = await getKv("codex-oauth-device", started.flowId);
    const state = JSON.parse(decryptSecret(String(entry!.value), getEncryptionKey())) as Record<
      string,
      unknown
    >;
    state.expiresAt = Date.now() - 1;
    await upsertKv({
      namespace: "codex-oauth-device",
      key: started.flowId,
      value: encryptSecret(JSON.stringify(state), getEncryptionKey()),
      valueType: "string",
      expiresAt: Number(state.expiresAt),
    });

    const poll = await request(`/api/codex-oauth/device/${started.flowId}/poll`);
    expect(await poll.json()).toEqual({ status: "expired" });
    const onboarding = await getSwarmConfigs({ scope: "global", key: "onboarding_state" });
    expect(onboarding[0]!.value).toBe(onboardingBefore[0]!.value);
  });

  test("unknown flow polling does not touch onboarding", async () => {
    await request("/api/onboarding", "GET");
    const onboardingBefore = await getSwarmConfigs({ scope: "global", key: "onboarding_state" });

    const poll = await request(`/api/codex-oauth/device/${crypto.randomUUID()}/poll`);
    expect(await poll.json()).toEqual({ status: "expired" });
    const onboardingAfter = await getSwarmConfigs({ scope: "global", key: "onboarding_state" });
    expect(onboardingAfter[0]!.value).toBe(onboardingBefore[0]!.value);
  });

  test("keeps a failed result sticky", async () => {
    await request("/api/onboarding", "GET");
    let pollCalls = 0;
    fetchImpl = (async (input) => {
      if (String(input) === DEVICE_CODE_URL) {
        return jsonResponse({ device_auth_id: "device-failed", user_code: "FAILED", interval: 1 });
      }
      if (String(input) === DEVICE_TOKEN_URL) {
        pollCalls += 1;
        return new Response(null, { status: 500 });
      }
      throw new Error("Unexpected fetch");
    }) as typeof fetch;

    const started = await startFlow();
    const path = `/api/codex-oauth/device/${started.flowId}/poll`;
    expect(await (await request(path)).json()).toEqual({
      status: "failed",
      error: "Device authorization failed (HTTP 500)",
    });
    const onboardingAfterFailure = await getSwarmConfigs({
      scope: "global",
      key: "onboarding_state",
    });
    expect(await (await request(path)).json()).toEqual({
      status: "failed",
      error: "Device authorization failed (HTTP 500)",
    });
    expect(pollCalls).toBe(1);
    const onboardingAfterRepeat = await getSwarmConfigs({
      scope: "global",
      key: "onboarding_state",
    });
    expect(onboardingAfterRepeat[0]!.value).toBe(onboardingAfterFailure[0]!.value);
  });

  test("returns 500 for local flow storage failure without touching onboarding", async () => {
    await request("/api/onboarding", "GET");
    const onboardingBefore = await getSwarmConfigs({ scope: "global", key: "onboarding_state" });
    fetchImpl = (async (input) => {
      expect(String(input)).toBe(DEVICE_CODE_URL);
      return jsonResponse({
        device_auth_id: "device-local-failure",
        user_code: "LOCAL",
        interval: 5,
      });
    }) as typeof fetch;
    await getDbClient().run(
      `CREATE TRIGGER fail_device_flow_write
       BEFORE INSERT ON kv_entries
       WHEN NEW.namespace = 'codex-oauth-device'
       BEGIN
         SELECT RAISE(ABORT, 'forced local write failure');
       END`,
    );

    try {
      const response = await request("/api/codex-oauth/device");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Failed to store Codex device login" });
    } finally {
      await getDbClient().run("DROP TRIGGER fail_device_flow_write");
    }

    const onboardingAfter = await getSwarmConfigs({ scope: "global", key: "onboarding_state" });
    expect(onboardingAfter[0]!.value).toBe(onboardingBefore[0]!.value);
  });

  test("returns 409 when OpenAI disables device login", async () => {
    await request("/api/onboarding", "GET");
    fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;

    const response = await request("/api/codex-oauth/device");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Codex device login is not enabled" });
    const onboarding = await getSwarmConfigs({ scope: "global", key: "onboarding_state" });
    const state = JSON.parse(onboarding[0]!.value) as OnboardingState;
    expect(state.steps.ai).toMatchObject({ status: "failed", errorClass: "not_enabled" });
  });
});
