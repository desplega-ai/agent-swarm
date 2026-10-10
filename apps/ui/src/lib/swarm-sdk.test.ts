import { describe, expect, test } from "bun:test";
import { makeSwarmSDK } from "./swarm-sdk";

function sdkAnswering(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const sdk = makeSwarmSDK({
    apiUrl: "https://api.example.test",
    getHeaders: () => ({ Authorization: "Bearer viewer" }),
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch,
  });
  return { sdk, calls };
}

describe("approvalRequests.respond", () => {
  test("a refused answer carries the server's reason and status", async () => {
    const { sdk } = sdkAnswering(403, {
      error: "You are not one of this request's approvers",
    });
    const error = (await sdk
      .invoke("approvalRequests.respond", { id: "req-1", body: { responses: {} } })
      .catch((e: unknown) => e)) as Error & { status?: number };
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      "swarm.sdk POST /api/approval-requests/req-1/respond: 403 You are not one of this request's approvers",
    );
  });

  test("answers with the viewer's headers only", async () => {
    const { sdk, calls } = sdkAnswering(200, { approvalRequest: { status: "pending" } });
    await sdk.invoke("approvalRequests.respond", { id: "req-1", body: { responses: {} } });
    expect(calls[0].init?.headers).toEqual({ Authorization: "Bearer viewer" });
  });
});
