import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { deleteOAuthTokens, storeOAuthTokens, upsertOAuthApp } from "../be/db-queries/oauth";
import {
  NotionApiError,
  NotionNotConnectedError,
  NotionRateLimitedError,
  notionFetch,
} from "../notion/client";
import * as ensureTokenModule from "../oauth/ensure-token";

const TEST_DB_PATH = "./test-notion-client.sqlite";
const originalFetch = globalThis.fetch;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  upsertOAuthApp("notion", {
    clientId: "id",
    clientSecret: "secret",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    redirectUri: "http://localhost:3013/cb",
    scopes: "",
  });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  mock.restore();
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

beforeEach(() => {
  storeOAuthTokens("notion", {
    accessToken: "at_initial",
    refreshToken: "rt_initial",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    scope: null,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("notionFetch — happy path", () => {
  test("adds Authorization Bearer + Notion-Version + Content-Type headers", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = mock(
      // biome-ignore lint/suspicious/noExplicitAny: fetch typing
      async (_url: any, init?: any) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ object: "list", results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    const result = await notionFetch<{ object: string }>("/search", {
      method: "POST",
      body: JSON.stringify({ query: "hello" }),
    });

    expect(result.object).toBe("list");
    expect(capturedHeaders!.Authorization).toBe("Bearer at_initial");
    expect(capturedHeaders!["Notion-Version"]).toBeTruthy();
    expect(capturedHeaders!["Content-Type"]).toBe("application/json");
  });

  test("rejects path missing leading slash", async () => {
    await expect(notionFetch("search")).rejects.toThrow(/must start with/);
  });
});

describe("notionFetch — not connected", () => {
  test("throws NotionNotConnectedError when no tokens row exists", async () => {
    deleteOAuthTokens("notion");
    await expect(notionFetch("/search")).rejects.toBeInstanceOf(NotionNotConnectedError);
  });
});

describe("notionFetch — 401 refresh+retry", () => {
  test("calls ensureToken once and retries with new access token", async () => {
    let callCount = 0;
    const tokensSeen: string[] = [];

    globalThis.fetch = mock(
      // biome-ignore lint/suspicious/noExplicitAny: fetch typing
      async (_url: any, init?: any) => {
        callCount += 1;
        const headers = init?.headers as Record<string, string>;
        const auth = headers.Authorization?.replace("Bearer ", "");
        tokensSeen.push(auth);
        if (callCount === 1) {
          return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    const ensureSpy = spyOn(ensureTokenModule, "ensureToken").mockImplementation(async () => {
      // Simulate refresh: rotate the access token in storage.
      storeOAuthTokens("notion", {
        accessToken: "at_refreshed",
        refreshToken: "rt_refreshed",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    });

    try {
      const result = await notionFetch<{ ok: boolean }>("/search", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(result.ok).toBe(true);
      expect(callCount).toBe(2);
      expect(tokensSeen).toEqual(["at_initial", "at_refreshed"]);
      expect(ensureSpy).toHaveBeenCalledTimes(1);
    } finally {
      ensureSpy.mockRestore();
    }
  });

  test("does NOT retry when refresh produces no new token", async () => {
    let callCount = 0;
    globalThis.fetch = mock(
      async () => {
        callCount += 1;
        return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
      },
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    const ensureSpy = spyOn(ensureTokenModule, "ensureToken").mockImplementation(async () => {
      // Refresh failed silently — token unchanged.
    });

    try {
      await expect(notionFetch("/search", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
        NotionApiError,
      );
      expect(callCount).toBe(1);
    } finally {
      ensureSpy.mockRestore();
    }
  });
});

describe("notionFetch — 429 surfaces structured rate-limit error", () => {
  test("emits NotionRateLimitedError with parsed Retry-After", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ code: "rate_limited", message: "Too many requests" }), {
          status: 429,
          headers: { "Retry-After": "12.5" },
        }),
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    let thrown: NotionRateLimitedError | undefined;
    try {
      await notionFetch("/search", { method: "POST", body: "{}" });
    } catch (err) {
      if (err instanceof NotionRateLimitedError) thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.retryAfterSeconds).toBe(12.5);
    expect(thrown!.message).toBe("Too many requests");
  });

  test("retryAfterSeconds null when header missing", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ message: "rl" }), { status: 429 }),
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    let thrown: NotionRateLimitedError | undefined;
    try {
      await notionFetch("/search", { method: "POST", body: "{}" });
    } catch (err) {
      if (err instanceof NotionRateLimitedError) thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.retryAfterSeconds).toBeNull();
  });
});

describe("notionFetch — generic API error", () => {
  test("emits NotionApiError with status + parsed code/message", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ code: "validation_error", message: "missing query" }), {
          status: 400,
        }),
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    let thrown: NotionApiError | undefined;
    try {
      await notionFetch("/search", { method: "POST", body: "{}" });
    } catch (err) {
      if (err instanceof NotionApiError) thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.status).toBe(400);
    expect(thrown!.code).toBe("validation_error");
    expect(thrown!.message).toBe("missing query");
  });
});
