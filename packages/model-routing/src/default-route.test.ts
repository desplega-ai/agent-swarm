import { describe, expect, test } from "bun:test";
import { deriveDefaultRoute, isFirstPartyAnthropicUrl, routeUnsetEnv } from "./default-route.ts";

const OAUTH = { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" };

describe("deriveDefaultRoute(claude)", () => {
  test("OAuth token → claude-subscription on api.anthropic.com", () => {
    const route = deriveDefaultRoute("claude", OAUTH);
    expect(route).toMatchObject({
      id: "default:claude",
      source: "default",
      provider: "claude-subscription",
      baseUrl: "https://api.anthropic.com",
      auth: { kind: "subscription", plan: "claude" },
    });
  });

  test("API key only → anthropic", () => {
    expect(deriveDefaultRoute("claude", { ANTHROPIC_API_KEY: "k" })).toMatchObject({
      provider: "anthropic",
      auth: { kind: "x-api-key", secretKey: "ANTHROPIC_API_KEY" },
    });
  });

  test("OAuth beats API key without a gateway (legacy precedence)", () => {
    expect(deriveDefaultRoute("claude", { ...OAUTH, ANTHROPIC_API_KEY: "k" })?.provider).toBe(
      "claude-subscription",
    );
  });

  test("gateway URL + auth token → anthropic-gateway bearer, even with OAuth set", () => {
    const route = deriveDefaultRoute("claude", {
      ...OAUTH,
      ANTHROPIC_BASE_URL: "http://litellm:4000",
      ANTHROPIC_AUTH_TOKEN: "sk-litellm",
    });
    expect(route).toMatchObject({
      provider: "anthropic-gateway",
      baseUrl: "http://litellm:4000",
      auth: { kind: "bearer", secretKey: "ANTHROPIC_AUTH_TOKEN" },
    });
  });

  test("gateway URL + API key → anthropic-gateway x-api-key", () => {
    expect(
      deriveDefaultRoute("claude", {
        ANTHROPIC_BASE_URL: "http://litellm:4000",
        ANTHROPIC_API_KEY: "k",
      }),
    ).toMatchObject({
      provider: "anthropic-gateway",
      auth: { kind: "x-api-key", secretKey: "ANTHROPIC_API_KEY" },
    });
  });

  test("OpenRouter's explicitly empty ANTHROPIC_API_KEY counts as unset", () => {
    expect(
      deriveDefaultRoute("claude", {
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
        ANTHROPIC_AUTH_TOKEN: "sk-or",
        ANTHROPIC_API_KEY: "",
      })?.auth,
    ).toEqual({ kind: "bearer", secretKey: "ANTHROPIC_AUTH_TOKEN" });
  });

  test("gateway URL with no key names the gateway's missing token", () => {
    expect(
      deriveDefaultRoute("claude", { ANTHROPIC_BASE_URL: "http://litellm:4000" }),
    ).toMatchObject({
      provider: "anthropic-gateway",
      auth: { kind: "bearer", secretKey: "ANTHROPIC_AUTH_TOKEN" },
    });
  });

  test("gateway URL + OAuth only stays a subscription route pointed at the URL", () => {
    expect(
      deriveDefaultRoute("claude", { ...OAUTH, ANTHROPIC_BASE_URL: "http://proxy:8080" }),
    ).toMatchObject({ provider: "claude-subscription", baseUrl: "http://proxy:8080" });
  });

  test("a first-party ANTHROPIC_BASE_URL is not a gateway", () => {
    expect(
      deriveDefaultRoute("claude", {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com/",
        ANTHROPIC_API_KEY: "k",
      })?.provider,
    ).toBe("anthropic");
  });

  test("Foundry with a resource and key", () => {
    expect(
      deriveDefaultRoute("claude", {
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_FOUNDRY_RESOURCE: "my-res",
        ANTHROPIC_FOUNDRY_API_KEY: "az",
      }),
    ).toMatchObject({
      provider: "foundry",
      protocol: "foundry",
      baseUrl: "https://my-res.services.ai.azure.com/anthropic",
      auth: { kind: "x-api-key", secretKey: "ANTHROPIC_FOUNDRY_API_KEY" },
    });
  });

  test("Foundry without a key uses the Entra ID chain", () => {
    expect(
      deriveDefaultRoute("claude", {
        CLAUDE_CODE_USE_FOUNDRY: "true",
        ANTHROPIC_FOUNDRY_RESOURCE: "r",
      })?.auth,
    ).toEqual({ kind: "cloud-chain" });
  });

  test("Bedrock and Vertex", () => {
    expect(
      deriveDefaultRoute("claude", { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" }),
    ).toMatchObject({
      provider: "bedrock",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      auth: { kind: "cloud-chain" },
    });
    expect(
      deriveDefaultRoute("claude", {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "us-east-1",
        AWS_BEARER_TOKEN_BEDROCK: "b",
      })?.auth,
    ).toEqual({ kind: "bearer", secretKey: "AWS_BEARER_TOKEN_BEDROCK" });
    expect(
      deriveDefaultRoute("claude", {
        CLAUDE_CODE_USE_VERTEX: "1",
        CLOUD_ML_REGION: "us-east5",
        ANTHROPIC_VERTEX_PROJECT_ID: "p",
      }),
    ).toMatchObject({
      provider: "vertex",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
      cloud: { region: "us-east5", project: "p" },
    });
  });

  test("cloud flags win over a gateway and OAuth; Foundry > Bedrock > Vertex", () => {
    const env = {
      ...OAUTH,
      ANTHROPIC_BASE_URL: "http://litellm:4000",
      ANTHROPIC_AUTH_TOKEN: "t",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
    };
    expect(deriveDefaultRoute("claude", env)?.provider).toBe("foundry");
    expect(deriveDefaultRoute("claude", { ...env, CLAUDE_CODE_USE_FOUNDRY: "0" })?.provider).toBe(
      "bedrock",
    );
    expect(
      deriveDefaultRoute("claude", {
        ...env,
        CLAUDE_CODE_USE_FOUNDRY: "",
        CLAUDE_CODE_USE_BEDROCK: "false",
      })?.provider,
    ).toBe("vertex");
  });

  test("no credentials → null", () => {
    expect(deriveDefaultRoute("claude", {})).toBeNull();
  });

  test("other harnesses are not routed yet", () => {
    for (const harness of ["codex", "pi", "opencode", "dsh", "devin"]) {
      expect(deriveDefaultRoute(harness, { ...OAUTH, ANTHROPIC_API_KEY: "k" })).toBeNull();
    }
  });
});

describe("routeUnsetEnv", () => {
  test("drops the OAuth token from every claude route except the subscription", () => {
    const gateway = deriveDefaultRoute("claude", {
      ...OAUTH,
      ANTHROPIC_BASE_URL: "http://litellm:4000",
      ANTHROPIC_AUTH_TOKEN: "t",
    });
    const foundry = deriveDefaultRoute("claude", { ...OAUTH, CLAUDE_CODE_USE_FOUNDRY: "1" });
    const sub = deriveDefaultRoute("claude", OAUTH);
    expect(gateway && routeUnsetEnv("claude", gateway)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(foundry && routeUnsetEnv("claude", foundry)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(sub && routeUnsetEnv("claude", sub)).toEqual([]);
  });
});

describe("isFirstPartyAnthropicUrl", () => {
  test("matches only Anthropic's API origin", () => {
    expect(isFirstPartyAnthropicUrl("https://api.anthropic.com")).toBe(true);
    expect(isFirstPartyAnthropicUrl("https://api.anthropic.com/v1")).toBe(true);
    expect(isFirstPartyAnthropicUrl("http://api.anthropic.com")).toBe(false);
    expect(isFirstPartyAnthropicUrl("https://api.anthropic.com.evil.io")).toBe(false);
    expect(isFirstPartyAnthropicUrl("garbage")).toBe(false);
  });
});
