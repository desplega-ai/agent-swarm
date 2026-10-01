import { afterEach, describe, expect, test } from "bun:test";
import { assertRouteHarness, routeCredentialStatus, validateRoute } from "./credential-status.ts";
import { deriveDefaultRoute } from "./default-route.ts";
import type { Env, ModelRoute } from "./types.ts";

function route(env: Env): ModelRoute {
  const r = deriveDefaultRoute("claude", env);
  if (!r) throw new Error("no route");
  return r;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Installs a recording fetch as globalThis.fetch, the only network path the package uses. */
function stubFetch(status: number, body = "{}") {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(body, { status });
  }) as typeof fetch;
  globalThis.fetch = impl;
  return { calls };
}

const GATEWAY = { ANTHROPIC_BASE_URL: "http://litellm:4000", ANTHROPIC_AUTH_TOKEN: "sk-gw" };

describe("routeCredentialStatus", () => {
  test("gateway, Foundry, Bedrock, Vertex report ready", () => {
    for (const env of [
      GATEWAY,
      {
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_FOUNDRY_RESOURCE: "r",
        ANTHROPIC_FOUNDRY_API_KEY: "k",
      },
      { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" },
      { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "global", ANTHROPIC_VERTEX_PROJECT_ID: "p" },
    ]) {
      expect(routeCredentialStatus(route(env), env)).toMatchObject({ ready: true, missing: [] });
    }
  });

  test("names what each route is missing", () => {
    const gw = { ANTHROPIC_BASE_URL: "http://litellm:4000" };
    expect(routeCredentialStatus(route(gw), gw).missing).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
    const foundry = { CLAUDE_CODE_USE_FOUNDRY: "1" };
    expect(routeCredentialStatus(route(foundry), foundry).missing).toEqual([
      "ANTHROPIC_FOUNDRY_RESOURCE",
    ]);
    const bedrock = { CLAUDE_CODE_USE_BEDROCK: "1" };
    expect(routeCredentialStatus(route(bedrock), bedrock).missing).toEqual(["AWS_REGION"]);
    const vertex = { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "us-east5" };
    const status = routeCredentialStatus(route(vertex), vertex);
    expect(status.missing).toEqual(["ANTHROPIC_VERTEX_PROJECT_ID"]);
    expect(status.hint).toContain("ANTHROPIC_VERTEX_PROJECT_ID");
  });
});

describe("validateRoute", () => {
  test("gateway: GET /v1/models on the gateway with its bearer token", async () => {
    const { calls } = stubFetch(200, JSON.stringify({ data: [{ id: "glm-4.6" }] }));
    const result = await validateRoute(route(GATEWAY), GATEWAY);
    expect(result).toEqual({ status: "verified", models: ["glm-4.6"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://litellm:4000/v1/models");
    expect(calls[0]?.headers.Authorization).toBe("Bearer sk-gw");
  });

  test("gateway: sends ANTHROPIC_CUSTOM_HEADERS like Claude Code does", async () => {
    const env = { ...GATEWAY, ANTHROPIC_CUSTOM_HEADERS: "X-Gateway-Client: claude-code\nbad line" };
    const { calls } = stubFetch(200);
    await validateRoute(route(env), env);
    expect(calls[0]?.headers["X-Gateway-Client"]).toBe("claude-code");
  });

  test("gateway: 401/403 fail, 404/405 are configured", async () => {
    for (const [status, expected] of [
      [401, "failed"],
      [403, "failed"],
      [404, "configured"],
      [405, "configured"],
      [500, "failed"],
    ] as const) {
      stubFetch(status);
      expect((await validateRoute(route(GATEWAY), GATEWAY)).status).toBe(expected);
    }
  });

  test("gateway API key goes as x-api-key to the gateway only", async () => {
    const env = { ANTHROPIC_BASE_URL: "http://litellm:4000", ANTHROPIC_API_KEY: "sk-gw" };
    const { calls } = stubFetch(200);
    await validateRoute(route(env), env);
    expect(calls.map((c) => c.url)).toEqual(["http://litellm:4000/v1/models"]);
    expect(calls[0]?.headers["x-api-key"]).toBe("sk-gw");
  });

  test("anthropic: checks api.anthropic.com with the API key", async () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant" };
    const { calls } = stubFetch(200);
    expect((await validateRoute(route(env), env)).status).toBe("verified");
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
  });

  test("subscription: presence only, no network", async () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "oauth" };
    const { calls } = stubFetch(500);
    expect((await validateRoute(route(env), env)).status).toBe("verified");
    expect(calls).toEqual([]);
  });

  test("cloud routes are configured without a network call", async () => {
    const env = { CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_RESOURCE: "r" };
    const { calls } = stubFetch(200);
    expect((await validateRoute(route(env), env)).status).toBe("configured");
    expect(calls).toEqual([]);
  });

  test("missing env fails before any network call", async () => {
    const env = { ANTHROPIC_BASE_URL: "http://litellm:4000" };
    const { calls } = stubFetch(200);
    expect(await validateRoute(route(env), env)).toMatchObject({
      status: "failed",
      missing: ["ANTHROPIC_AUTH_TOKEN"],
    });
    expect(calls).toEqual([]);
  });

  test("a thrown fetch becomes failed", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await validateRoute(route(GATEWAY), GATEWAY)).toEqual({
      status: "failed",
      reason: "ECONNREFUSED",
    });
  });
});

describe("assertRouteHarness", () => {
  test("the Claude subscription is claude-only", () => {
    const sub = route({ CLAUDE_CODE_OAUTH_TOKEN: "o" });
    expect(assertRouteHarness(sub, "claude")).toBeNull();
    for (const harness of ["pi", "opencode", "codex", "dsh"]) {
      expect(assertRouteHarness(sub, harness)).toContain("only available to the claude harness");
    }
  });

  test("non-routable harnesses are rejected", () => {
    expect(assertRouteHarness(route(GATEWAY), "devin")).toContain("cannot use a model route");
  });
});
