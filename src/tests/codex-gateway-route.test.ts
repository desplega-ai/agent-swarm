/**
 * Codex gateway route: `CODEX_GATEWAY_BASE_URL` + `CODEX_GATEWAY_API_KEY`
 * send Codex through an OpenAI Responses-compatible gateway. Covers route
 * selection in the adapter, the presence gate, and the live check.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { validateProviderCredentials } from "../commands/provider-credentials";
import { CodexAdapter, checkCodexCredentials } from "../providers/codex-adapter";
import type { ProviderSessionConfig } from "../providers/types";

const GATEWAY_ENV = {
  CODEX_GATEWAY_BASE_URL: "https://sub2api.example.com/v1",
  CODEX_GATEWAY_API_KEY: "sk-gateway",
};
const OAUTH_BLOB = JSON.stringify({
  access: "oauth-access",
  refresh: "r",
  expires: 1,
  accountId: "a",
});

function makeFakeThread() {
  return {
    id: null as string | null,
    async runStreamed() {
      async function* generate() {
        yield { type: "turn.completed" as const };
      }
      return { events: generate() };
    },
    async steer() {},
    async interrupt() {},
    async close() {},
  };
}

function testConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "hello",
    systemPrompt: "",
    model: "gpt-5.4",
    role: "worker",
    agentId: "11111111-1111-4111-8111-111111111111",
    apiUrl: "http://127.0.0.1:9",
    apiKey: "test",
    cwd: "/tmp",
    logFile: `/tmp/codex-gateway-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    ...overrides,
  };
}

async function captureSpawn(
  env: Record<string, string>,
  extra: Partial<ProviderSessionConfig> = {},
) {
  let captured: { env: Record<string, string>; codexConfig: Record<string, unknown> } | undefined;
  const config = testConfig({ env, ...extra });
  const adapter = new CodexAdapter({
    bypassSubprocess: true,
    threadFactory: ({ env: spawnEnv, codexConfig }) => {
      captured = { env: spawnEnv, codexConfig };
      return makeFakeThread();
    },
  });
  const session = await adapter.createSession(config);
  await session.waitForCompletion();
  await Bun.file(config.logFile).delete();
  if (!captured) throw new Error("thread factory not called");
  return captured;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("codex gateway route: adapter", () => {
  test("adds a Responses provider block and keeps OAuth and OPENAI_API_KEY out of the CLI env", async () => {
    const log = spyOn(console, "log");
    // codexSlot set: without the gateway route this would revalidate the pool
    // slot against the (unreachable) API and throw.
    const { env, codexConfig } = await captureSpawn(
      { ...GATEWAY_ENV, CODEX_OAUTH: OAUTH_BLOB, OPENAI_API_KEY: "sk-openai" },
      { codexSlot: 0 },
    );
    const logged = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();

    expect(codexConfig.model_provider).toBe("swarm-gateway");
    expect(codexConfig.model_providers).toEqual({
      "swarm-gateway": {
        name: "Swarm gateway",
        base_url: "https://sub2api.example.com/v1",
        env_key: "CODEX_GATEWAY_API_KEY",
        wire_api: "responses",
        requires_openai_auth: false,
      },
    });
    expect(env.CODEX_GATEWAY_API_KEY).toBe("sk-gateway");
    expect(env.CODEX_OAUTH).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(logged.some((line) => line.endsWith("Using credential: gateway"))).toBe(true);
  });

  test("a gateway URL on api.openai.com is not a gateway: no provider block", async () => {
    const { codexConfig, env } = await captureSpawn({
      CODEX_GATEWAY_BASE_URL: "https://api.openai.com/v1",
      CODEX_GATEWAY_API_KEY: "k",
      OPENAI_API_KEY: "sk-openai",
    });
    expect(codexConfig.model_provider).toBeUndefined();
    expect(codexConfig.model_providers).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
  });
});

describe("codex gateway route: credential gate", () => {
  const noAuthJson = { homeDir: "/nonexistent", fs: { existsSync: () => false } };
  const withAuthJson = { homeDir: "/home/worker", fs: { existsSync: () => true } };

  test("the gateway URL + key alone is ready", () => {
    expect(checkCodexCredentials(GATEWAY_ENV, noAuthJson)).toMatchObject({
      ready: true,
      satisfiedBy: "env",
    });
  });

  test("a gateway URL without its key is not ready, even with auth.json or OAuth", () => {
    const env = {
      CODEX_GATEWAY_BASE_URL: GATEWAY_ENV.CODEX_GATEWAY_BASE_URL,
      CODEX_OAUTH: OAUTH_BLOB,
    };
    expect(checkCodexCredentials(env, withAuthJson)).toMatchObject({
      ready: false,
      missing: ["CODEX_GATEWAY_API_KEY"],
    });
  });

  test("live check calls the gateway's /v1/models with the gateway key, never api.openai.com", async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url: String(url), auth: headers?.Authorization });
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }] }), { status: 200 });
    }) as typeof fetch;

    const result = await validateProviderCredentials("codex", {
      ...GATEWAY_ENV,
      OPENAI_API_KEY: "sk-openai",
      CODEX_OAUTH: OAUTH_BLOB,
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(calls).toEqual([
      { url: "https://sub2api.example.com/v1/models", auth: "Bearer sk-gateway" },
    ]);
  });

  test("live check reports the gateway's 401", async () => {
    globalThis.fetch = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
    const result = await validateProviderCredentials("codex", GATEWAY_ENV);
    expect(result).toMatchObject({ ok: false, httpStatus: 401 });
  });
});
