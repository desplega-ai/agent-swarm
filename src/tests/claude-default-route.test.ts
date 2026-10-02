/**
 * Issue #1800: a claude worker on a LiteLLM gateway, Microsoft Foundry,
 * Bedrock, or Vertex passes the credential gate with no Anthropic credential,
 * and its gateway key never reaches api.anthropic.com.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildCredStatusReport,
  checkProviderCredentials,
  validateProviderCredentials,
} from "../commands/provider-credentials";
import {
  buildClaudeSessionEnvironment,
  checkClaudeCredentials,
  resolveClaudeBinaryArgv,
  withClaudeRouteEnv,
} from "../providers/claude-adapter";
import type { ProviderSessionConfig } from "../providers/types";
import { resolveCredentialPools, validateClaudeCredentials } from "../utils/credentials";
import { resolveCredential } from "../utils/internal-ai/credentials";

const GATEWAY_URL = "http://litellm.internal:4000";
const UNTRUSTED_URL = { ANTHROPIC_BASE_URL: "https://untrusted.example" };
const LITELLM_BEARER = { ANTHROPIC_BASE_URL: GATEWAY_URL, ANTHROPIC_AUTH_TOKEN: "sk-litellm" };
const LITELLM_API_KEY = { ANTHROPIC_BASE_URL: GATEWAY_URL, ANTHROPIC_API_KEY: "sk-litellm" };
const FOUNDRY = {
  CLAUDE_CODE_USE_FOUNDRY: "1",
  ANTHROPIC_FOUNDRY_RESOURCE: "my-foundry",
  ANTHROPIC_FOUNDRY_API_KEY: "az-key",
};
const BEDROCK = { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" };
const VERTEX = {
  CLAUDE_CODE_USE_VERTEX: "1",
  CLOUD_ML_REGION: "us-east5",
  ANTHROPIC_VERTEX_PROJECT_ID: "proj",
};
const OAUTH = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-example" };

/** Records every request, whichever fetch the code under test reaches for. */
let requests: string[] = [];
let realFetch: typeof fetch;
const recordingFetch = (async (url: string | URL | Request) => {
  requests.push(String(url instanceof Request ? url.url : url));
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
}) as typeof fetch;

beforeEach(() => {
  requests = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = recordingFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const anthropicRequests = () => requests.filter((url) => url.includes("api.anthropic.com"));

describe("claude credential gate", () => {
  for (const [name, env] of Object.entries({
    "LiteLLM bearer": LITELLM_BEARER,
    "LiteLLM api key": LITELLM_API_KEY,
    Foundry: FOUNDRY,
    Bedrock: BEDROCK,
    Vertex: VERTEX,
  })) {
    test(`${name} reports ready without an Anthropic credential`, async () => {
      expect(checkClaudeCredentials(env)).toMatchObject({ ready: true, missing: [] });
      expect((await checkProviderCredentials("claude", env)).ready).toBe(true);
    });
  }

  test("no route lists the first-party credentials and mentions the alternatives", () => {
    const status = checkClaudeCredentials({});
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
    expect(status.hint).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(status.hint).toContain("CLAUDE_CODE_USE_FOUNDRY");
  });

  test("an incomplete Foundry route names its missing resource", () => {
    expect(checkClaudeCredentials({ CLAUDE_CODE_USE_FOUNDRY: "1", ...OAUTH })).toMatchObject({
      ready: false,
      missing: ["ANTHROPIC_FOUNDRY_RESOURCE"],
    });
  });
});

describe("claude live check", () => {
  test("gateway keys are checked against the gateway, never api.anthropic.com", async () => {
    for (const env of [LITELLM_BEARER, LITELLM_API_KEY, { ...LITELLM_API_KEY, ...OAUTH }]) {
      const result = await validateProviderCredentials("claude", env);
      expect(result.ok).toBe(true);
    }
    expect(requests).toEqual([
      `${GATEWAY_URL}/v1/models`,
      `${GATEWAY_URL}/v1/models`,
      `${GATEWAY_URL}/v1/models`,
    ]);
    expect(anthropicRequests()).toEqual([]);
  });

  test("Foundry makes no request and is reported as configured, not verified", async () => {
    const result = await validateProviderCredentials("claude", FOUNDRY);
    expect(result).toMatchObject({ ok: true, skipped: true });
    const report = await buildCredStatusReport("claude", FOUNDRY, {}, "boot");
    expect(report.ready).toBe(true);
    expect(report.liveTest).toBeNull();
    expect(requests).toEqual([]);
  });

  test("a rejected gateway key fails the live test", async () => {
    const reject = (async () =>
      new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    globalThis.fetch = reject;
    const result = await validateProviderCredentials("claude", LITELLM_BEARER);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 401");
  });

  test("buildCredStatusReport checks the env it was given, not only process.env", async () => {
    const report = await buildCredStatusReport("claude", LITELLM_BEARER, {}, "post_task");
    expect(report.liveTest?.ok).toBe(true);
    expect(requests).toEqual([`${GATEWAY_URL}/v1/models`]);
  });

  test("an Anthropic API key without a gateway still checks api.anthropic.com", async () => {
    await validateProviderCredentials("claude", { ANTHROPIC_API_KEY: "sk-ant" });
    expect(requests).toEqual(["https://api.anthropic.com/v1/models"]);
  });
});

describe("claude spawn env", () => {
  const config = (env: Record<string, string>) =>
    ({
      taskId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      env,
      apiUrl: "http://fixture.invalid",
      apiKey: "example-fixture-swarm-key",
    }) as ProviderSessionConfig;
  const spawnEnv = (env: Record<string, string>) =>
    buildClaudeSessionEnvironment(config(env), "sonnet", "/tmp/fixture-task").env;
  /** The spawned env carries the token under no key, and OAuth is explicitly blank. */
  const expectNoSubscriptionToken = (env: Record<string, string>, token: string) => {
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
    expect(Object.values(env).filter((value) => value?.includes(token))).toEqual([]);
  };

  test("a gateway route blanks the OAuth token so it cannot reach the gateway", () => {
    const { env } = buildClaudeSessionEnvironment(
      config({ ...LITELLM_BEARER, ...OAUTH }),
      "sonnet",
      "/tmp/fixture-task",
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-litellm");
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY_URL);
  });

  test("cloud routes blank the OAuth token too", () => {
    for (const route of [FOUNDRY, BEDROCK, VERTEX]) {
      expect(withClaudeRouteEnv({ ...route, ...OAUTH }).CLAUDE_CODE_OAUTH_TOKEN).toBe("");
    }
  });

  test("the subscription route keeps the OAuth token", () => {
    const { env } = buildClaudeSessionEnvironment(config(OAUTH), "sonnet", "/tmp/fixture-task");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH.CLAUDE_CODE_OAUTH_TOKEN);
  });

  test("arbitrary URL + OAuth + no gateway key parks and spawns without the token", async () => {
    const env = { ...UNTRUSTED_URL, ...OAUTH };
    expect(checkClaudeCredentials(env)).toMatchObject({
      ready: false,
      missing: ["ANTHROPIC_AUTH_TOKEN"],
    });
    expect(() => validateClaudeCredentials(env)).toThrow("ANTHROPIC_AUTH_TOKEN");
    expect((await validateProviderCredentials("claude", env)).ok).toBe(false);
    expect((await buildCredStatusReport("claude", env, {}, "boot")).liveTest).toBeNull();
    expect(requests).toEqual([]);
    expectNoSubscriptionToken(spawnEnv(env), OAUTH.CLAUDE_CODE_OAUTH_TOKEN);
  });

  test("an OAuth token picked from the pool never reaches a keyless gateway", async () => {
    const env: Record<string, string> = {
      ...UNTRUSTED_URL,
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-pool-a,sk-ant-oat01-pool-b",
    };
    await resolveCredentialPools(env, { provider: "claude" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^sk-ant-oat01-pool-[ab]$/);
    expect(checkClaudeCredentials(env).ready).toBe(false);
    expectNoSubscriptionToken(spawnEnv(env), "sk-ant-oat01-pool");
  });

  test("an OAuth token inherited from process.env is blanked, not revived", () => {
    const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = OAUTH.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      const env = withClaudeRouteEnv({ ...UNTRUSTED_URL, SWARM_USE_CLAUDE_BRIDGE: "true" });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
      expect(resolveClaudeBinaryArgv(env).useClaudeBridge).toBe(false);
      expectNoSubscriptionToken(
        spawnEnv({ ...UNTRUSTED_URL, SWARM_USE_CLAUDE_BRIDGE: "true" }),
        OAUTH.CLAUDE_CODE_OAUTH_TOKEN,
      );
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
    }
  });

  test("a gateway key cleared after being set does not fall back to OAuth", () => {
    const env: Record<string, string> = { ...UNTRUSTED_URL, ...OAUTH, ANTHROPIC_AUTH_TOKEN: "k" };
    expect(checkClaudeCredentials(env).ready).toBe(true);
    expectNoSubscriptionToken(spawnEnv(env), OAUTH.CLAUDE_CODE_OAUTH_TOKEN);

    for (const cleared of [
      { ...env, ANTHROPIC_AUTH_TOKEN: "" },
      Object.fromEntries(Object.entries(env).filter(([key]) => key !== "ANTHROPIC_AUTH_TOKEN")),
    ]) {
      expect(checkClaudeCredentials(cleared)).toMatchObject({
        ready: false,
        missing: ["ANTHROPIC_AUTH_TOKEN"],
      });
      expectNoSubscriptionToken(spawnEnv(cleared), OAUTH.CLAUDE_CODE_OAUTH_TOKEN);
    }
  });

  test("claude-bridge stays off on a gateway route even when process.env has OAuth", () => {
    const env = withClaudeRouteEnv({
      ...LITELLM_BEARER,
      ...OAUTH,
      SWARM_USE_CLAUDE_BRIDGE: "true",
    });
    const argv = resolveClaudeBinaryArgv(env, { ...OAUTH });
    expect(argv.useClaudeBridge).toBe(false);
  });
});

describe("internal-ai credential", () => {
  const opts = (env: NodeJS.ProcessEnv) => ({
    env,
    _getEnvApiKey: () => undefined,
    _getValidCodexOAuth: async () => null,
    _getOAuthApiKey: async () => null,
    _persistCodexOAuth: async () => undefined,
  });

  test("a gateway's ANTHROPIC_API_KEY is not used for api.anthropic.com calls", async () => {
    expect(await resolveCredential(opts(LITELLM_API_KEY))).toBeNull();
  });

  test("an ANTHROPIC_API_KEY with a first-party base URL is still used", async () => {
    const cred = await resolveCredential(
      opts({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk-ant" }),
    );
    expect(cred?.kind).toBe("anthropic");
  });
});
