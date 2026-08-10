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
