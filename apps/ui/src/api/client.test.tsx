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

  test("sends a simple opaque request directly to the configured endpoint", async () => {
    globalThis.fetch = async (url, init) => {
      expect(url).toBe("https://proxy.example.test/v1/feedback");
      expect(init?.method).toBe("POST");
      expect(init?.mode).toBe("no-cors");
      expect(init?.headers).toEqual({ "Content-Type": "text/plain;charset=UTF-8" });
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return new Response(null, { status: 202 });
    };

    await expect(
      api.submitFeedback("https://proxy.example.test/v1/feedback", input),
    ).resolves.toBeUndefined();
  });

  test("cannot inspect an opaque proxy response", async () => {
    globalThis.fetch = async () => ({ status: 0, type: "opaque" }) as Response;

    await expect(
      api.submitFeedback("https://proxy.example.test/v1/feedback", input),
    ).resolves.toBeUndefined();
  });
});
