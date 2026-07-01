/**
 * Reproduction + regression coverage for the Codex OAuth pool refresh-token
 * race (see storage.ts `getValidCodexOAuth` doc comment for the full
 * analysis).
 *
 * Codex refresh tokens are single-use: OpenAI rotates the refresh token on
 * every `/oauth/token` exchange and revokes the whole token family if a
 * stale/already-rotated refresh token is replayed. `getValidCodexOAuth` used
 * to have no lock around the refresh-and-persist critical section, so two
 * tasks racing the same pool slot with an expired access token would BOTH
 * exchange the same refresh token — the loser replaying a token OpenAI
 * already rotated.
 *
 * This suite runs a real HTTP server backed by the actual
 * `handleOAuthLocks` route handler and a real SQLite-backed
 * `oauth_refresh_locks` table (migration 077) — the same atomic UPSERT the
 * tracker-OAuth path relies on — so the "exactly one exchange" assertion
 * below is backed by the real lock, not a mocked one. Only the swarm config
 * store (where credentials are persisted) and the OpenAI token endpoint are
 * mocked, matching the style of `codex-oauth-storage.test.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { closeDb, initDb } from "../be/db";
import { handleOAuthLocks } from "../http/oauth-locks";
import { resetFetchForTesting, setFetchForTesting } from "../providers/codex-oauth/flow.js";
import { getValidCodexOAuth } from "../providers/codex-oauth/storage.js";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types.js";

const TEST_DB_PATH = "./test-codex-oauth-refresh-lock.sqlite";
const MOCK_API_URL = "http://localhost:3013";
const MOCK_API_KEY = "test-api-key";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");

let lockServer: Server;
let lockServerOrigin: string;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  initDb(TEST_DB_PATH);

  lockServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");
    const pathSegments = url.pathname.split("/").filter(Boolean);
    void handleOAuthLocks(req, res, pathSegments, url.searchParams).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => lockServer.listen(0, "127.0.0.1", resolve));
  const addr = lockServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  lockServerOrigin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => lockServer.close(resolve));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetFetchForTesting();
});

/**
 * Fake swarm config store backing `loadCodexOAuth`/`storeCodexOAuth`, wired
 * to the REAL lock server for `/api/oauth/refresh-locks/*` requests so the
 * critical section is genuinely serialized through SQLite, not a test
 * double. `creds` is mutated in place, mirroring the shared pool slot two
 * concurrent tasks would race over.
 */
function installMockTransport(store: { creds: CodexOAuthCredentials }): void {
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (urlStr.startsWith(`${MOCK_API_URL}/api/oauth/refresh-locks/`)) {
      const forwarded = urlStr.replace(MOCK_API_URL, lockServerOrigin);
      return originalFetch(forwarded, init);
    }

    if (method === "GET" && urlStr.includes("/api/config/resolved")) {
      return new Response(
        JSON.stringify({
          configs: [{ id: "cfg-1", key: "codex_oauth_0", value: JSON.stringify(store.creds) }],
        }),
        { status: 200 },
      );
    }

    if (method === "PUT" && urlStr.includes("/api/config")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as { value: string };
      store.creds = JSON.parse(body.value) as CodexOAuthCredentials;
      return new Response(JSON.stringify({ id: "cfg-1" }), { status: 200 });
    }

    throw new Error(`Unexpected fetch in test: ${method} ${urlStr}`);
  };
}

describe("getValidCodexOAuth — concurrent pool refresh", () => {
  it("performs exactly ONE /oauth/token exchange when two callers race the same expired slot", async () => {
    const store = {
      creds: {
        access: "at_stale",
        refresh: "rt_gen0",
        expires: Date.now() - 1000, // already expired
        accountId: "acc-test",
      } satisfies CodexOAuthCredentials,
    };
    installMockTransport(store);

    let exchangeCount = 0;
    const seenRefreshTokens: string[] = [];
    setFetchForTesting(async (_url: string | URL | Request, init?: RequestInit) => {
      exchangeCount += 1;
      const params = new URLSearchParams((init?.body as string) ?? "");
      seenRefreshTokens.push(params.get("refresh_token") ?? "");
      // Widen the race window so both callers are guaranteed to be past
      // their initial (pre-lock) read before either finishes exchanging.
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(
        JSON.stringify({
          access_token: "at_gen1",
          refresh_token: "rt_gen1",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const [first, second] = await Promise.all([
      getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0),
      getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0),
    ]);

    // The core claim: only one caller ever exchanged rt_gen0 with OpenAI.
    // On the pre-fix code (no lock), this is 2 — the reproduction case.
    expect(exchangeCount).toBe(1);
    expect(seenRefreshTokens).toEqual(["rt_gen0"]);

    // Both callers must observe the SAME rotated credentials — the loser
    // picks up the winner's tokens via the post-lock re-read instead of
    // exchanging the now-stale rt_gen0 itself.
    expect(first?.access).toBe("at_gen1");
    expect(second?.access).toBe("at_gen1");
    expect(first?.refresh).toBe("rt_gen1");
    expect(second?.refresh).toBe("rt_gen1");

    // Persisted state matches what both callers received.
    expect(store.creds.access).toBe("at_gen1");
    expect(store.creds.refresh).toBe("rt_gen1");
  });

  it("performs exactly ONE /oauth/token exchange when two callers race the same near-expiry (but not yet expired) slot", async () => {
    const store = {
      creds: {
        access: "at_stale",
        refresh: "rt_gen0",
        // Still technically valid, but inside the refresh-skew window — must
        // be treated the same as expired, not fast-pathed past the lock.
        expires: Date.now() + 30 * 1000,
        accountId: "acc-test",
      } satisfies CodexOAuthCredentials,
    };
    installMockTransport(store);

    let exchangeCount = 0;
    const seenRefreshTokens: string[] = [];
    setFetchForTesting(async (_url: string | URL | Request, init?: RequestInit) => {
      exchangeCount += 1;
      const params = new URLSearchParams((init?.body as string) ?? "");
      seenRefreshTokens.push(params.get("refresh_token") ?? "");
      // Widen the race window so both callers are guaranteed to be past
      // their initial (pre-lock) read before either finishes exchanging.
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(
        JSON.stringify({
          access_token: "at_gen1",
          refresh_token: "rt_gen1",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const [first, second] = await Promise.all([
      getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0),
      getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0),
    ]);

    // The core claim: only one caller ever exchanged rt_gen0 with OpenAI,
    // even though the token was still technically valid (not yet expired)
    // when both callers made their first read.
    expect(exchangeCount).toBe(1);
    expect(seenRefreshTokens).toEqual(["rt_gen0"]);

    // Both callers must observe the SAME rotated credentials.
    expect(first?.access).toBe("at_gen1");
    expect(second?.access).toBe("at_gen1");
    expect(first?.refresh).toBe("rt_gen1");
    expect(second?.refresh).toBe("rt_gen1");

    expect(store.creds.access).toBe("at_gen1");
    expect(store.creds.refresh).toBe("rt_gen1");
  });

  it("does not re-exchange when a third caller arrives after the race is already resolved", async () => {
    const store = {
      creds: {
        access: "at_stale",
        refresh: "rt_gen0",
        expires: Date.now() - 1000,
        accountId: "acc-test",
      } satisfies CodexOAuthCredentials,
    };
    installMockTransport(store);

    let exchangeCount = 0;
    setFetchForTesting(async () => {
      exchangeCount += 1;
      return new Response(
        JSON.stringify({ access_token: "at_gen1", refresh_token: "rt_gen1", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const first = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0);
    expect(first?.access).toBe("at_gen1");
    expect(exchangeCount).toBe(1);

    // Slot is now valid (expires in the future) — a later caller must hit
    // the fast path and never touch the lock or the token endpoint again.
    const second = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0);
    expect(second?.access).toBe("at_gen1");
    expect(exchangeCount).toBe(1);
  });

  it("quarantines the slot instead of leaving a replayable stale refresh token when persisting fails", async () => {
    const store: { creds: CodexOAuthCredentials | null } = {
      creds: {
        access: "at_stale",
        refresh: "rt_gen0",
        expires: Date.now() - 1000,
        accountId: "acc-test",
      },
    };
    globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (urlStr.startsWith(`${MOCK_API_URL}/api/oauth/refresh-locks/`)) {
        return originalFetch(urlStr.replace(MOCK_API_URL, lockServerOrigin), init);
      }
      if (method === "GET" && urlStr.includes("/api/config/resolved")) {
        return new Response(
          JSON.stringify({
            configs: store.creds
              ? [{ id: "cfg-1", key: "codex_oauth_0", value: JSON.stringify(store.creds) }]
              : [],
          }),
          { status: 200 },
        );
      }
      if (method === "PUT" && urlStr.includes("/api/config")) {
        // Simulate a persist failure — the config store is unreachable.
        return new Response("Server Error", { status: 500 });
      }
      if (method === "DELETE" && urlStr.includes("/api/config/cfg-1")) {
        // The quarantine path: delete the slot from the config store so the
        // next caller's `loadCodexOAuth` finds nothing.
        store.creds = null;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected fetch in test: ${method} ${urlStr}`);
    };

    let exchangeCount = 0;
    setFetchForTesting(async () => {
      exchangeCount += 1;
      return new Response(
        JSON.stringify({ access_token: "at_gen1", refresh_token: "rt_gen1", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    // Must reject rather than resolve with the unpersisted `refreshed`
    // credentials — silently swallowing this would leave rt_gen0 (already
    // rotated with OpenAI) as the stored refresh token for the next caller
    // to replay.
    await expect(getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0)).rejects.toThrow(
      "Failed to store",
    );
    expect(exchangeCount).toBe(1);

    // The slot must be quarantined (deleted), NOT left holding the stale,
    // already-rotated refresh token for a subsequent caller to read back out.
    expect(store.creds).toBeNull();

    // A second caller after the persist failure must see the slot as gone —
    // it must NOT hit /oauth/token with the old (already-consumed) refresh
    // token, since that replay is exactly the family revocation this lock
    // exists to prevent.
    const second = await getValidCodexOAuth(MOCK_API_URL, MOCK_API_KEY, 0);
    expect(second).toBeNull();
    expect(exchangeCount).toBe(1);
  });
});
