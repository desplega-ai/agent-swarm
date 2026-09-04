import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@/lib/config", () => ({
  getConfig: () => ({ apiUrl: "https://api.example.test", apiKey: "" }),
}));

const { api } = await import("./client");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("respondToApprovalRequest", () => {
  test("surfaces the server error message", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "Required responses missing or invalid: reason" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });

    await expect(api.respondToApprovalRequest("request-id", {})).rejects.toThrow(
      "Required responses missing or invalid: reason",
    );
  });

  test("falls back to the response status when the body has no error", async () => {
    globalThis.fetch = async () => new Response("Bad request", { status: 400 });

    await expect(api.respondToApprovalRequest("request-id", {})).rejects.toThrow(
      "Failed to respond to approval request: 400",
    );
  });
});

describe("submitFeedback", () => {
  const input = {
    submission_id: "attempt-stable-across-retries",
    user_id: "user-1",
    install_id: null,
    installed_at: null,
    org_name: "Acme",
    swarm_version: "1.138.0",
    newsletter_consent: false,
    submitted_at: "2026-09-04T12:00:00.000Z",
  };

  test("falls back to a simple opaque request when the readable request rejects", async () => {
    let call = 0;
    globalThis.fetch = async (url, init) => {
      expect(url).toBe("https://proxy.example.test/v1/feedback");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(input);

      call += 1;
      if (call === 1) {
        expect(init?.mode).toBeUndefined();
        expect(init?.headers).toEqual({ "Content-Type": "application/json" });
        throw new TypeError("Failed to fetch");
      }

      expect(init?.mode).toBe("no-cors");
      expect(init?.headers).toEqual({ "Content-Type": "text/plain;charset=UTF-8" });
      return new Response(null, { status: 202 });
    };

    await expect(
      api.submitFeedback("https://proxy.example.test/v1/feedback", input),
    ).resolves.toBeUndefined();
    expect(call).toBe(2);
  });

  test("accepts an opaque fallback response", async () => {
    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      if (call === 1) throw new TypeError("Failed to fetch");
      return { status: 0, type: "opaque" } as Response;
    };

    await expect(
      api.submitFeedback("https://proxy.example.test/v1/feedback", input),
    ).resolves.toBeUndefined();
    expect(call).toBe(2);
  });

  test("uses the readable JSON response when CORS succeeds", async () => {
    globalThis.fetch = async (url, init) => {
      expect(url).toBe("https://proxy.example.test/v1/feedback");
      expect(init?.method).toBe("POST");
      expect(init?.mode).toBeUndefined();
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return new Response(null, { status: 202 });
    };

    await expect(
      api.submitFeedback("https://proxy.example.test/v1/feedback", input),
    ).resolves.toBeUndefined();
  });

  test("allows HTTP feedback submissions to loopback hosts", async () => {
    globalThis.fetch = async (url) => {
      expect(url).toBe("http://localhost:3013/v1/feedback");
      return new Response(null, { status: 202 });
    };

    await expect(
      api.submitFeedback("http://localhost:3013/v1/feedback", input),
    ).resolves.toBeUndefined();
  });

  test("rejects unsafe feedback endpoints before fetching", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 202 });
    };

    for (const endpoint of ["http://evil.example/v1/feedback", "not a URL"]) {
      await expect(api.submitFeedback(endpoint, input)).rejects.toThrow(
        "Invalid feedback endpoint",
      );
    }
    expect(calls).toBe(0);
  });

  test("surfaces a readable non-2xx response without falling back", async () => {
    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      return new Response(JSON.stringify({ code: "rate_limited" }), { status: 429 });
    };

    await expect(
      api.submitFeedback("https://proxy.example.test/v1/feedback", input),
    ).rejects.toThrow("Failed to submit feedback: 429");
    expect(call).toBe(1);
  });
});
