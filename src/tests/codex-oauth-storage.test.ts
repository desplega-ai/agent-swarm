import { afterEach, describe, expect, it } from "bun:test";
import { resetFetchForTesting, setFetchForTesting } from "../providers/codex-oauth/flow.js";
import {
  deleteCodexOAuth,
  getValidCodexOAuth,
  loadCodexOAuth,
  storeCodexOAuth,
} from "../providers/codex-oauth/storage.js";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types.js";

const MOCK_API_URL = "http://localhost:3013";
const MOCK_API_KEY = "test-api-key";

const mockCreds: CodexOAuthCredentials = {
  access: "at_test123",
  refresh: "rt_test456",
  expires: Date.now() + 3600000,
  accountId: "acc-test-789",
};

describe("storeCodexOAuth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends correct PUT request with isSecret: true", async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ id: "cfg-1", key: "codex_oauth", scope: "global", value: "stored" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    await storeCodexOAuth(MOCK_API_URL, MOCK_API_KEY, mockCreds);

    expect(capturedBody).not.toBeNull();
    const body = capturedBody as Record<string, unknown>;
    expect(body.scope).toBe("global");
    expect(body.key).toBe("codex_oauth");
    expect(body.isSecret).toBe(true);
    expect(JSON.parse(body.value as string)).toEqual(mockCreds);
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = async () => new Response("Server Error", { status: 500 });

    await expect(storeCodexOAuth(MOCK_API_URL, MOCK_API_KEY, mockCreds)).rejects.toThrow(
      "Failed to store codex_oauth config",
    );
  });
});

describe("loadCodexOAuth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses config response correctly", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [
            {
              id: "cfg-1",
              key: "codex_oauth",
              value: JSON.stringify(mockCreds),
              scope: "global",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await loadCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(result).not.toBeNull();
    expect(result!.access).toBe(mockCreds.access);
    expect(result!.refresh).toBe(mockCreds.refresh);
    expect(result!.accountId).toBe(mockCreds.accountId);
  });

  it("returns null when no config found", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ configs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await loadCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    globalThis.fetch = async () => new Response("Not Found", { status: 404 });

    const result = await loadCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = async () => {
      throw new Error("ConnectionRefused");
    };

    const result = await loadCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toBeNull();
  });

  it("returns null on invalid JSON value", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [{ id: "cfg-1", key: "codex_oauth", value: "not-json", scope: "global" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await loadCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toBeNull();
  });
});

describe("deleteCodexOAuth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends DELETE request for the config entry", async () => {
    let deleteUrl = "";
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const method = init?.method || "GET";

      if (method === "DELETE") {
        deleteUrl = urlStr;
      }

      if (urlStr.includes("config/resolved")) {
        return new Response(
          JSON.stringify({
            configs: [{ id: "cfg-123", key: "codex_oauth", value: "{}", scope: "global" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await deleteCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(deleteUrl).toContain("cfg-123");
  });

  it("does nothing when no config found", async () => {
    let deleteCalled = false;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method || "GET";
      if (method === "DELETE") {
        deleteCalled = true;
      }
      return new Response(JSON.stringify({ configs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await deleteCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(deleteCalled).toBe(false);
  });
});

describe("getValidCodexOAuth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetFetchForTesting();
  });

  it("returns cached credentials when not expired", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [
            {
              id: "cfg-1",
              key: "codex_oauth",
              value: JSON.stringify({ ...mockCreds, expires: Date.now() + 3600000 }),
              scope: "global",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(result).not.toBeNull();
    expect(result!.access).toBe(mockCreds.access);
  });

  it("refreshes expired tokens and re-stores", async () => {
    let putCalled = false;
    const expiredCreds = { ...mockCreds, expires: Date.now() - 1000 };

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const method = init?.method || "GET";

      if (method === "GET" && urlStr.includes("config/resolved")) {
        return new Response(
          JSON.stringify({
            configs: [
              {
                id: "cfg-1",
                key: "codex_oauth",
                value: JSON.stringify(expiredCreds),
                scope: "global",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (method === "PUT") {
        putCalled = true;
        return new Response(JSON.stringify({ id: "cfg-1", key: "codex_oauth", scope: "global" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    setFetchForTesting(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "at_refreshed",
            refresh_token: "rt_refreshed",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(result).not.toBeNull();
    expect(result!.access).toBe("at_refreshed");
    expect(result!.refresh).toBe("rt_refreshed");
    expect(putCalled).toBe(true);
  });

  it("returns null when refresh fails", async () => {
    const expiredCreds = { ...mockCreds, expires: Date.now() - 1000 };

    globalThis.fetch = async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("config/resolved")) {
        return new Response(
          JSON.stringify({
            configs: [
              {
                id: "cfg-1",
                key: "codex_oauth",
                value: JSON.stringify(expiredCreds),
                scope: "global",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not Found", { status: 404 });
    };

    setFetchForTesting(() => new Response("Unauthorized", { status: 401 }));

    const result = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toBeNull();
  });

  it("returns null when no credentials stored", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ configs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toBeNull();
  });
});
