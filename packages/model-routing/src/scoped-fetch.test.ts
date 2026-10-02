import { describe, expect, test } from "bun:test";
import { createScopedFetch, ScopedFetchError } from "./scoped-fetch.ts";

function recorder() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("{}");
  }) as typeof fetch;
  return { calls, impl };
}

describe("createScopedFetch", () => {
  test("appends relative paths to the base URL and keeps its path prefix", async () => {
    const { calls, impl } = recorder();
    const scoped = createScopedFetch("https://openrouter.ai/api/", impl);
    await scoped("/v1/models");
    await scoped("v1/messages");
    expect(calls.map((c) => c.url)).toEqual([
      "https://openrouter.ai/api/v1/models",
      "https://openrouter.ai/api/v1/messages",
    ]);
  });

  test("a second origin throws before any network call", async () => {
    const { calls, impl } = recorder();
    const scoped = createScopedFetch("http://litellm.internal:4000", impl);
    for (const path of [
      "https://api.anthropic.com/v1/models",
      "//api.anthropic.com/v1/models",
      "http://litellm.internal:4001/v1/models",
    ]) {
      await expect(scoped(path)).rejects.toBeInstanceOf(ScopedFetchError);
    }
    expect(calls).toEqual([]);
  });

  test("allows an absolute URL on the same origin", async () => {
    const { calls, impl } = recorder();
    await createScopedFetch(
      "http://litellm.internal:4000",
      impl,
    )("http://litellm.internal:4000/v1/models");
    expect(calls).toHaveLength(1);
  });

  test("never follows redirects, even when asked to", async () => {
    const { calls, impl } = recorder();
    await createScopedFetch("https://gw.example.com", impl)("/v1/models", { redirect: "follow" });
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  test("rejects an invalid base URL", () => {
    expect(() => createScopedFetch("not a url")).toThrow(ScopedFetchError);
  });
});
