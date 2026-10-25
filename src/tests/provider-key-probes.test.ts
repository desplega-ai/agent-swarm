import { afterEach, describe, expect, mock, test } from "bun:test";
import { checkProviderPoolKey } from "../utils/provider-key-probes";

describe("API pool key probes", () => {
  const realFetch = globalThis.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPrivateUrls = process.env.ALLOW_PRIVATE_NETWORK_URLS;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalPrivateUrls === undefined) delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
    else process.env.ALLOW_PRIVATE_NETWORK_URLS = originalPrivateUrls;
  });

  test("uses the supplied OpenRouter URL and forbids redirects", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: calls.length === 1 ? 404 : 200 });
    }) as typeof fetch;
    expect(
      await checkProviderPoolKey("OPENROUTER_API_KEY", "fake-abcde", {
        OPENROUTER_BASE_URL: "https://gateway.example/v1/",
      }),
    ).toMatchObject({ ok: true });
    expect(calls.map((call) => call.url)).toEqual([
      "https://gateway.example/v1/key",
      "https://gateway.example/v1/models",
    ]);
    expect(calls.every((call) => call.init?.redirect === "manual")).toBe(true);
  });

  test("rejects a private registry URL before sending credentials", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
    const fetch = mock(async () => new Response("{}"));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const result = await checkProviderPoolKey("NAN_API_KEY", "fake-abcde", {
      NAN_BASE_URL: "https://127.0.0.1/v1",
    });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("supports registry aliases and configured URLs", async () => {
    const fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://gateway.example/v1/models");
      expect(init?.headers).toEqual({ Authorization: "Bearer fake-abcde" });
      expect(init?.redirect).toBe("manual");
      return new Response("Unauthorized", { status: 401 });
    });
    globalThis.fetch = fetch as typeof globalThis.fetch;
    expect(
      await checkProviderPoolKey("HELMCODE_API_NAN", "fake-abcde", {
        NAN_BASE_URL: "https://gateway.example/v1",
      }),
    ).toMatchObject({ ok: false, httpStatus: 401 });
  });

  test.each([
    [200, "{}", true, false],
    [403, '{"error":{"type":"permission_error"}}', true, false],
    [403, '{"error":{"type":"other"}}', false, false],
    [401, "Unauthorized", false, false],
    [429, "Throttled", true, true],
    [503, "Unavailable", true, true],
  ])("preserves Claude OAuth semantics for HTTP %i", async (status, body, ok, skipped) => {
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.anthropic.com/api/oauth/profile");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(body, { status });
    }) as typeof fetch;
    const result = await checkProviderPoolKey("CLAUDE_CODE_OAUTH_TOKEN", "fake-abcde", {});
    expect(result.ok).toBe(ok);
    expect(result.skipped === true).toBe(skipped);
    if (!ok) expect(result.httpStatus).toBe(status);
  });

  test("checks an Anthropic key at its gateway, keeping the URL path prefix", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;
    const result = await checkProviderPoolKey("ANTHROPIC_API_KEY", "fake-abcde", {
      ANTHROPIC_BASE_URL: "https://gateway.example/api",
    });
    expect(result).toMatchObject({ ok: false, httpStatus: 401 });
    expect(calls.map((call) => call.url)).toEqual(["https://gateway.example/api/v1/models"]);
    expect(new Headers(calls[0]?.init?.headers).get("x-api-key")).toBe("fake-abcde");
    expect(calls[0]?.init?.redirect).toBe("manual");

    globalThis.fetch = mock(async () => new Response("{}")) as unknown as typeof fetch;
    expect(
      await checkProviderPoolKey("ANTHROPIC_API_KEY", "fake-abcde", {
        ANTHROPIC_BASE_URL: "https://gateway.example/api",
      }),
    ).toMatchObject({ ok: true });
  });

  test("a gateway that lists no models leaves the Anthropic key unchecked", async () => {
    globalThis.fetch = mock(
      async () => new Response("Not found", { status: 404 }),
    ) as unknown as typeof fetch;
    expect(
      await checkProviderPoolKey("ANTHROPIC_API_KEY", "fake-abcde", {
        ANTHROPIC_BASE_URL: "https://gateway.example",
      }),
    ).toMatchObject({ ok: true, skipped: true });
  });

  test("an Anthropic key stays on api.anthropic.com when the gateway uses ANTHROPIC_AUTH_TOKEN", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(
      await checkProviderPoolKey("ANTHROPIC_API_KEY", "fake-abcde", {
        ANTHROPIC_BASE_URL: "https://gateway.example",
        ANTHROPIC_AUTH_TOKEN: "gateway-token",
      }),
    ).toMatchObject({ ok: true });
    expect(urls).toEqual(["https://api.anthropic.com/v1/models"]);
  });

  test("a private Anthropic gateway gets no credentials and no rejection", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
    const fetch = mock(async () => new Response("{}"));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const result = await checkProviderPoolKey("ANTHROPIC_API_KEY", "fake-abcde", {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
    });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("skips keys without an API-safe probe", async () => {
    const fetch = mock(async () => new Response("{}"));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    for (const keyType of ["DEVIN_API_KEY", "AMP_API_KEY", "CURSOR_API_KEY"]) {
      expect(await checkProviderPoolKey(keyType, "fake-abcde", {})).toMatchObject({
        ok: true,
        skipped: true,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("reports network errors without exposing the submitted key", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Rejected fake-abcde");
    }) as unknown as typeof fetch;
    const result = await checkProviderPoolKey("OPENAI_API_KEY", "fake-abcde", {});
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("fake-abcde");
  });

  test.each([
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "NAN_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ])("redacts a long echoed %s before truncating the provider error", async (keyType) => {
    const apiKey = "Z".repeat(240);
    globalThis.fetch = mock(
      async () => new Response(`Rejected ${apiKey}`, { status: 403 }),
    ) as unknown as typeof fetch;
    const result = await checkProviderPoolKey(keyType, apiKey, {});
    expect(result).toMatchObject({ ok: false, httpStatus: 403 });
    expect(result.error).toContain("[REDACTED]");
    expect(result.error).not.toContain(apiKey.slice(0, 40));
  });
});
