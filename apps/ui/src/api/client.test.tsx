import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@/lib/config", () => ({
  getConfig: () => ({ apiUrl: "https://api.example.test", apiKey: "" }),
}));

const { api, FeedbackSubmissionError } = await import("./client");

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
    newsletter_consent: false,
    submitted_at: "2026-09-04T12:00:00.000Z",
  };

  test("returns the proxy acceptance response", async () => {
    globalThis.fetch = async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return Response.json(
        { status: "accepted", submission_id: input.submission_id },
        { status: 202 },
      );
    };

    await expect(api.submitFeedback(input)).resolves.toEqual({
      status: "accepted",
      submission_id: input.submission_id,
    });
  });

  test("preserves a rate limit and its Retry-After seconds", async () => {
    globalThis.fetch = async () =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "3600" } });

    try {
      await api.submitFeedback(input);
      throw new Error("Expected submitFeedback to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(FeedbackSubmissionError);
      expect((error as InstanceType<typeof FeedbackSubmissionError>).status).toBe(429);
      expect((error as InstanceType<typeof FeedbackSubmissionError>).retryAfterSeconds).toBe(3600);
    }
  });
});
