import { afterEach, describe, expect, test } from "bun:test";
import { reportKeyRateLimitWindows } from "../commands/runner";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(status: number, ok: boolean) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ success: ok }), { status });
  }) as typeof fetch;
  return calls;
}

describe("reportKeyRateLimitWindows — response-failure path", () => {
  test("throws when the report endpoint returns a non-2xx response", async () => {
    mockFetch(500, false);

    await expect(
      reportKeyRateLimitWindows("https://api.test", "test-key", "ANTHROPIC_API_KEY", "aaa11", 0, {
        seven_day_overage_included: {
          status: "rejected",
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
          lastSeenAt: new Date().toISOString(),
        },
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  test("throws on a 4xx response too", async () => {
    mockFetch(400, false);

    await expect(
      reportKeyRateLimitWindows("https://api.test", "test-key", "ANTHROPIC_API_KEY", "aaa11", 0, {
        seven_day_opus: {
          status: "rejected",
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
          lastSeenAt: new Date().toISOString(),
        },
      }),
    ).rejects.toThrow(/HTTP 400/);
  });

  test("failure-path error message never includes the key suffix", async () => {
    mockFetch(500, false);
    const keySuffix = "aaa11";

    let thrown: unknown;
    try {
      await reportKeyRateLimitWindows(
        "https://api.test",
        "test-key",
        "ANTHROPIC_API_KEY",
        keySuffix,
        0,
        {
          seven_day_opus: {
            status: "rejected",
            resetsAt: Math.floor(Date.now() / 1000) + 3600,
            lastSeenAt: new Date().toISOString(),
          },
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(keySuffix);
  });

  test("resolves without throwing on a 2xx response", async () => {
    mockFetch(200, true);

    await expect(
      reportKeyRateLimitWindows("https://api.test", "test-key", "ANTHROPIC_API_KEY", "aaa11", 0, {
        seven_day_sonnet: {
          status: "rejected",
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
          lastSeenAt: new Date().toISOString(),
        },
      }),
    ).resolves.toBeUndefined();
  });

  test("empty windows short-circuits without calling fetch", async () => {
    const calls = mockFetch(200, true);

    await reportKeyRateLimitWindows(
      "https://api.test",
      "test-key",
      "ANTHROPIC_API_KEY",
      "aaa11",
      0,
      {},
    );

    expect(calls).toHaveLength(0);
  });
});
