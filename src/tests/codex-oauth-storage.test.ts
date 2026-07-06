import { afterEach, describe, expect, it } from "bun:test";
import { resetFetchForTesting, setFetchForTesting } from "../providers/codex-oauth/flow.js";
import {
  CodexOAuthRefreshError,
  codexOAuthKeyForSlot,
  deleteCodexOAuth,
  getValidCodexOAuth,
  loadAllCodexOAuthSlots,
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

/** Immediately grants/releases the refresh lock — for tests exercising refresh mechanics, not the lock itself. */
function mockLockResponse(method: string): Response | null {
  if (method === "POST")
    return new Response(JSON.stringify({ owner: "test-owner" }), { status: 200 });
  if (method === "DELETE") return new Response(null, { status: 204 });
  return null;
}

// ─── codexOAuthKeyForSlot ────────────────────────────────────────────────────

describe("codexOAuthKeyForSlot", () => {
  it("returns codex_oauth_0 for slot 0", () => {
    expect(codexOAuthKeyForSlot(0)).toBe("codex_oauth_0");
  });

  it("returns codex_oauth_1 for slot 1", () => {
    expect(codexOAuthKeyForSlot(1)).toBe("codex_oauth_1");
  });

  it("returns codex_oauth_9 for slot 9", () => {
    expect(codexOAuthKeyForSlot(9)).toBe("codex_oauth_9");
  });
});

// ─── storeCodexOAuth ─────────────────────────────────────────────────────────

describe("storeCodexOAuth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("stores to codex_oauth_0 by default (slot omitted)", async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ id: "cfg-1", key: "codex_oauth_0", scope: "global", value: "stored" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    await storeCodexOAuth(MOCK_API_URL, MOCK_API_KEY, mockCreds);

    const body = capturedBody as Record<string, unknown>;
    expect(body.key).toBe("codex_oauth_0");
    expect(body.scope).toBe("global");
    expect(body.isSecret).toBe(true);
    expect(JSON.parse(body.value as string)).toEqual(mockCreds);
  });

  it("stores to codex_oauth_1 for slot 1", async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: "cfg-2" }), { status: 200 });
    };

    await storeCodexOAuth(MOCK_API_URL, MOCK_API_KEY, mockCreds, 1);

    const body = capturedBody as Record<string, unknown>;
    expect(body.key).toBe("codex_oauth_1");
  });

  it("stores to codex_oauth_2 for slot 2", async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: "cfg-3" }), { status: 200 });
    };

    await storeCodexOAuth(MOCK_API_URL, MOCK_API_KEY, mockCreds, 2);

    const body = capturedBody as Record<string, unknown>;
    expect(body.key).toBe("codex_oauth_2");
  });

  it("storing slot 1 does not overwrite slot 0 key", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({ id: "cfg-ok" }), { status: 200 });
    };

    await storeCodexOAuth(MOCK_API_URL, MOCK_API_KEY, mockCreds, 0);
    await storeCodexOAuth(MOCK_API_URL, MOCK_API_KEY, mockCreds, 1);

    expect(capturedBodies[0]?.key).toBe("codex_oauth_0");
    expect(capturedBodies[1]?.key).toBe("codex_oauth_1");
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = async () => new Response("Server Error", { status: 500 });

    await expect(storeCodexOAuth(MOCK_API_URL, MOCK_API_KEY, mockCreds)).rejects.toThrow(
      "Failed to store codex_oauth_0 config",
    );
  });
});

// ─── loadCodexOAuth ──────────────────────────────────────────────────────────

describe("loadCodexOAuth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads slot 0 from codex_oauth_0 key", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [{ id: "cfg-1", key: "codex_oauth_0", value: JSON.stringify(mockCreds) }],
        }),
        { status: 200 },
      );

    const result = await loadCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0);
    expect(result?.access).toBe(mockCreds.access);
  });

  it("reads slot 1 from codex_oauth_1 key", async () => {
    const slot1Creds = { ...mockCreds, access: "at_slot1" };
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [
            { id: "cfg-0", key: "codex_oauth_0", value: JSON.stringify(mockCreds) },
            { id: "cfg-1", key: "codex_oauth_1", value: JSON.stringify(slot1Creds) },
          ],
        }),
        { status: 200 },
      );

    const result = await loadCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 1);
    expect(result?.access).toBe("at_slot1");
  });

  it("backwards-compat: slot 0 falls back to legacy codex_oauth when codex_oauth_0 absent", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [{ id: "cfg-legacy", key: "codex_oauth", value: JSON.stringify(mockCreds) }],
        }),
        { status: 200 },
      );

    const result = await loadCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0);
    expect(result?.access).toBe(mockCreds.access);
    expect(result?.accountId).toBe(mockCreds.accountId);
  });

  it("does NOT use legacy key for slots other than 0", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [{ id: "cfg-legacy", key: "codex_oauth", value: JSON.stringify(mockCreds) }],
        }),
        { status: 200 },
      );

    const result = await loadCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 1);
    expect(result).toBeNull();
  });

  it("slot 0 prefers codex_oauth_0 over legacy when both exist", async () => {
    const slotCreds = { ...mockCreds, access: "at_slot0_preferred" };
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [
            { id: "cfg-legacy", key: "codex_oauth", value: JSON.stringify(mockCreds) },
            { id: "cfg-slot0", key: "codex_oauth_0", value: JSON.stringify(slotCreds) },
          ],
        }),
        { status: 200 },
      );

    const result = await loadCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0);
    expect(result?.access).toBe("at_slot0_preferred");
  });

  it("returns null when no config found", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ configs: [] }), { status: 200 });

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
          configs: [{ id: "cfg-1", key: "codex_oauth_0", value: "not-json" }],
        }),
        { status: 200 },
      );

    const result = await loadCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toBeNull();
  });
});

// ─── loadAllCodexOAuthSlots ──────────────────────────────────────────────────

describe("loadAllCodexOAuthSlots", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns empty array when no slots exist", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ configs: [] }), { status: 200 });

    const result = await loadAllCodexOAuthSlots(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toEqual([]);
  });

  it("returns slots in ascending order", async () => {
    const creds2 = { ...mockCreds, access: "at_slot2" };
    const creds0 = { ...mockCreds, access: "at_slot0" };
    const creds1 = { ...mockCreds, access: "at_slot1" };

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [
            { id: "cfg-2", key: "codex_oauth_2", value: JSON.stringify(creds2) },
            { id: "cfg-0", key: "codex_oauth_0", value: JSON.stringify(creds0) },
            { id: "cfg-1", key: "codex_oauth_1", value: JSON.stringify(creds1) },
            // should be ignored — not a slot key
            { id: "cfg-other", key: "slack_token", value: "xoxb-123" },
            // should also be ignored — legacy key is not included in loadAll
            { id: "cfg-legacy", key: "codex_oauth", value: JSON.stringify(mockCreds) },
          ],
        }),
        { status: 200 },
      );

    const result = await loadAllCodexOAuthSlots(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ slot: 0 });
    expect(result[0]?.creds.access).toBe("at_slot0");
    expect(result[1]).toMatchObject({ slot: 1 });
    expect(result[1]?.creds.access).toBe("at_slot1");
    expect(result[2]).toMatchObject({ slot: 2 });
    expect(result[2]?.creds.access).toBe("at_slot2");
  });

  it("skips entries with invalid JSON values", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [
            { id: "cfg-0", key: "codex_oauth_0", value: JSON.stringify(mockCreds) },
            { id: "cfg-1", key: "codex_oauth_1", value: "not-valid-json" },
          ],
        }),
        { status: 200 },
      );

    const result = await loadAllCodexOAuthSlots(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toHaveLength(1);
    expect(result[0]?.slot).toBe(0);
  });

  it("returns empty array on HTTP error", async () => {
    globalThis.fetch = async () => new Response("Error", { status: 500 });
    const result = await loadAllCodexOAuthSlots(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    globalThis.fetch = async () => {
      throw new Error("Network error");
    };
    const result = await loadAllCodexOAuthSlots(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toEqual([]);
  });
});

// ─── deleteCodexOAuth ─────────────────────────────────────────────────────────

describe("deleteCodexOAuth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends DELETE request for the slot 0 config entry", async () => {
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
            configs: [{ id: "cfg-123", key: "codex_oauth_0", value: "{}" }],
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    await deleteCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(deleteUrl).toContain("cfg-123");
  });

  it("does nothing when no config found for slot", async () => {
    let deleteCalled = false;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method || "GET") === "DELETE") deleteCalled = true;
      return new Response(JSON.stringify({ configs: [] }), { status: 200 });
    };

    await deleteCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(deleteCalled).toBe(false);
  });
});

// ─── getValidCodexOAuth ──────────────────────────────────────────────────────

describe("getValidCodexOAuth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetFetchForTesting();
  });

  it("returns cached credentials when not expired (slot 0)", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [
            {
              id: "cfg-1",
              key: "codex_oauth_0",
              // 2 days out — comfortably past the 12h REFRESH_SKEW_MS.
              value: JSON.stringify({
                ...mockCreds,
                expires: Date.now() + 2 * 24 * 60 * 60 * 1000,
              }),
            },
          ],
        }),
        { status: 200 },
      );

    const result = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(result).not.toBeNull();
    expect(result!.access).toBe(mockCreds.access);
  });

  it("reads from correct slot when slot 1 requested", async () => {
    const slot1Creds = {
      ...mockCreds,
      access: "at_slot1",
      expires: Date.now() + 2 * 24 * 60 * 60 * 1000,
    };
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [
            { id: "cfg-0", key: "codex_oauth_0", value: JSON.stringify(mockCreds) },
            { id: "cfg-1", key: "codex_oauth_1", value: JSON.stringify(slot1Creds) },
          ],
        }),
        { status: 200 },
      );

    const result = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 1);
    expect(result?.access).toBe("at_slot1");
  });

  it("refreshes expired tokens and re-stores to same slot", async () => {
    let putCapturedKey = "";
    const expiredCreds = { ...mockCreds, expires: Date.now() - 1000 };

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const method = init?.method || "GET";

      if (method === "GET" && urlStr.includes("config/resolved")) {
        return new Response(
          JSON.stringify({
            configs: [{ id: "cfg-1", key: "codex_oauth_0", value: JSON.stringify(expiredCreds) }],
          }),
          { status: 200 },
        );
      }

      if (urlStr.includes("/api/oauth/refresh-locks/")) {
        const lockRes = mockLockResponse(method);
        if (lockRes) return lockRes;
      }

      if (method === "PUT") {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        putCapturedKey = body.key as string;
        return new Response(JSON.stringify({ id: "cfg-1" }), { status: 200 });
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
          { status: 200 },
        ),
    );

    const result = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0);
    expect(result?.access).toBe("at_refreshed");
    expect(putCapturedKey).toBe("codex_oauth_0");
  });

  it("returns null when no credentials stored", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ configs: [] }), { status: 200 });

    const result = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    expect(result).toBeNull();
  });

  it("throws CodexOAuthRefreshError (not a silent null) when refresh is rejected", async () => {
    const expiredCreds = { ...mockCreds, expires: Date.now() - 1000 };

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const method = init?.method || "GET";

      if (urlStr.includes("config/resolved")) {
        return new Response(
          JSON.stringify({
            configs: [{ id: "cfg-1", key: "codex_oauth_0", value: JSON.stringify(expiredCreds) }],
          }),
          { status: 200 },
        );
      }

      if (urlStr.includes("/api/oauth/refresh-locks/")) {
        const lockRes = mockLockResponse(method);
        if (lockRes) return lockRes;
      }

      return new Response("Not Found", { status: 404 });
    };

    setFetchForTesting(() => new Response("invalid_grant", { status: 401 }));

    let caught: unknown;
    try {
      await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CodexOAuthRefreshError);
    const err = caught as CodexOAuthRefreshError;
    expect(err.reason).toBe("refresh_rejected");
    expect(err.status).toBe(401);
    expect(err.body).toBe("invalid_grant");
    expect(err.slot).toBe(0);
  });

  it("treats a token older than maxAgeMs as needing refresh even though it isn't near expiry", async () => {
    // Issued ~9 days ago (expires derived as issuedAt + 10d TTL): comfortably
    // past the default 5min-turned-12h REFRESH_SKEW_MS, but well past a
    // keep-warm maxAgeMs of 7 days.
    const nineDaysAgo = Date.now() - 9 * 24 * 60 * 60 * 1000;
    const staleByAgeCreds = {
      ...mockCreds,
      expires: nineDaysAgo + 10 * 24 * 60 * 60 * 1000,
    };
    let putCapturedKey = "";

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const method = init?.method || "GET";

      if (method === "GET" && urlStr.includes("config/resolved")) {
        return new Response(
          JSON.stringify({
            configs: [
              { id: "cfg-1", key: "codex_oauth_0", value: JSON.stringify(staleByAgeCreds) },
            ],
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes("/api/oauth/refresh-locks/")) {
        const lockRes = mockLockResponse(method);
        if (lockRes) return lockRes;
      }
      if (method === "PUT") {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        putCapturedKey = body.key as string;
        return new Response(JSON.stringify({ id: "cfg-1" }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    setFetchForTesting(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "at_keepwarm_refreshed",
            refresh_token: "rt_keepwarm_refreshed",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );

    const result = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0, {
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(result?.access).toBe("at_keepwarm_refreshed");
    expect(putCapturedKey).toBe("codex_oauth_0");
  });

  it("does NOT refresh a token within maxAgeMs when opts is omitted (default behavior unchanged)", async () => {
    const nineDaysAgo = Date.now() - 9 * 24 * 60 * 60 * 1000;
    const staleByAgeCreds = {
      ...mockCreds,
      expires: nineDaysAgo + 10 * 24 * 60 * 60 * 1000,
    };

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          configs: [{ id: "cfg-1", key: "codex_oauth_0", value: JSON.stringify(staleByAgeCreds) }],
        }),
        { status: 200 },
      );
    setFetchForTesting(async () => {
      throw new Error("no refresh should happen without opts.maxAgeMs");
    });

    const result = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0);
    expect(result?.access).toBe(mockCreds.access);
  });

  it("refreshes a token that a zero-skew (pi-ai-equivalent) check would still call valid — ordering invariant (Risk R4)", async () => {
    // Ordering invariant: pi-ai's own refresh check uses zero skew
    // (`Date.now() >= expires`). Widening REFRESH_SKEW_MS must never make
    // this function refresh LATER than that — otherwise pi-ai could observe
    // a token this function hasn't refreshed yet and race an unlocked
    // refresh outside `/api/oauth/refresh-locks`.
    const almostExpired = Date.now() + 60 * 1000; // 1 min out — a zero-skew check says "not expired yet"
    expect(Date.now() >= almostExpired).toBe(false); // sanity: pi-ai would treat this as still valid

    const nearExpiryCreds = { ...mockCreds, expires: almostExpired };
    let exchanged = false;

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const method = init?.method || "GET";
      if (method === "GET" && urlStr.includes("config/resolved")) {
        return new Response(
          JSON.stringify({
            configs: [
              { id: "cfg-1", key: "codex_oauth_0", value: JSON.stringify(nearExpiryCreds) },
            ],
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes("/api/oauth/refresh-locks/")) {
        const lockRes = mockLockResponse(method);
        if (lockRes) return lockRes;
      }
      if (method === "PUT") return new Response(JSON.stringify({ id: "cfg-1" }), { status: 200 });
      return new Response("Not Found", { status: 404 });
    };
    setFetchForTesting(async () => {
      exchanged = true;
      return new Response(
        JSON.stringify({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 }),
        { status: 200 },
      );
    });

    await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0);
    // getValidCodexOAuth (12h skew) already refreshed a token a zero-skew
    // check would still call valid — it wins the race by construction.
    expect(exchanged).toBe(true);
  });
});
