/**
 * Key status is matched by key suffix when the caller sends its pool
 * (`GET /api/keys/available?keySuffixes=`), so two agent-scoped pools with
 * different keys at the same index do not bench each other (issue #2425).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  getAvailableKeyIndices,
  initDb,
  markKeyRateLimited,
  recordKeyRateLimitWindows,
} from "../be/db";
import { recordKeyValidation } from "../be/db/api-keys";
import { handleApiKeys } from "../http/api-keys";
import { resolveCredentialPools } from "../utils/credentials";
import { listenOnFreePort } from "./test-net";

const TEST_DB = `./test-api-key-status-by-suffix-${Date.now()}.sqlite`;
const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

// Agent A and agent B each pool two keys; index 1 differs between them.
const POOL_A = ["example-key-shared", "example-key-aaaa1"];
const POOL_B = ["example-key-shared", "example-key-bbbb2"];
const suffixes = (pool: string[]) => pool.map((key) => key.slice(-5));

describe("key status by suffix", () => {
  let server: Server;
  let baseUrl = "";

  const getAvailable = async (query: string) => {
    const res = await fetch(`${baseUrl}/api/keys/available?${query}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    process.env.DB_PATH = TEST_DB;
    initDb(TEST_DB);
    server = createHttpServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      const pathSegments = url.pathname.split("/").filter(Boolean);
      const handled = await handleApiKeys(req, res, pathSegments, url.searchParams);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    const port = await listenOnFreePort(server);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    await unlink(TEST_DB).catch(() => {});
    await unlink(`${TEST_DB}-wal`).catch(() => {});
    await unlink(`${TEST_DB}-shm`).catch(() => {});
  });

  test("a rate limit on agent A's key at index 1 does not bench agent B's key at index 1", async () => {
    // Workers report at global scope, by suffix and index.
    await markKeyRateLimited("OPENAI_API_KEY", "aaaa1", 1, FUTURE());

    const a = await getAvailableKeyIndices("OPENAI_API_KEY", 2, "global", null, undefined, [
      ...suffixes(POOL_A),
    ]);
    const b = await getAvailableKeyIndices("OPENAI_API_KEY", 2, "global", null, undefined, [
      ...suffixes(POOL_B),
    ]);
    expect(a.availableIndices).toEqual([0]);
    expect(b.availableIndices).toEqual([0, 1]);

    // Control: the index read (no suffixes) still benches index 1 for everyone.
    const legacy = await getAvailableKeyIndices("OPENAI_API_KEY", 2);
    expect(legacy.availableIndices).toEqual([0]);
  });

  test("a rejection on agent A's key does not bench agent B's key at the same index", async () => {
    await recordKeyValidation(
      "GEMINI_API_KEY",
      [{ keyIndex: 1, keySuffix: "aaaa1", ok: false, httpStatus: 401 }],
      "global",
      null,
      { retireAbsent: false },
    );

    const a = await getAvailable(
      `keyType=GEMINI_API_KEY&totalKeys=2&keySuffixes=${suffixes(POOL_A).join(",")}`,
    );
    const b = await getAvailable(
      `keyType=GEMINI_API_KEY&totalKeys=2&keySuffixes=${suffixes(POOL_B).join(",")}`,
    );
    expect(a.body).toMatchObject({ availableIndices: [0], rejectedIndices: [1] });
    expect(b.body).toMatchObject({ availableIndices: [0, 1], rejectedIndices: [] });
  });

  test("one key in two scopes has one state, at each pool's own position", async () => {
    // The shared key sits at index 0 for A and B, and at index 2 in a third pool.
    await markKeyRateLimited("ANTHROPIC_API_KEY", "hared", 0, FUTURE());
    // A row of the same key in an agent scope (for example a dashboard check) also counts.
    await recordKeyValidation(
      "ANTHROPIC_API_KEY",
      [{ keyIndex: 0, keySuffix: "hared", ok: false, httpStatus: 401 }],
      "agent",
      "agent-b",
      { retireAbsent: false },
    );

    const b = await getAvailableKeyIndices("ANTHROPIC_API_KEY", 2, "global", null, undefined, [
      ...suffixes(POOL_B),
    ]);
    expect(b.availableIndices).toEqual([1]);
    expect(b.rejectedIndices).toEqual([0]);

    const reordered = ["example-key-ccccc", "example-key-ddddd", "example-key-shared"];
    const c = await getAvailableKeyIndices("ANTHROPIC_API_KEY", 3, "global", null, undefined, [
      ...suffixes(reordered),
    ]);
    expect(c.availableIndices).toEqual([0, 1]);
    expect(c.rejectedIndices).toEqual([2]);
  });

  test("model window blocks map to the caller's positions", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    await recordKeyRateLimitWindows("CLAUDE_CODE_OAUTH_TOKEN", "aaaa1", 1, {
      seven_day_opus: { status: "rejected", resetsAt, lastSeenAt: new Date().toISOString() },
    });

    const a = await getAvailableKeyIndices(
      "CLAUDE_CODE_OAUTH_TOKEN",
      2,
      "global",
      null,
      "opus",
      suffixes(POOL_A),
    );
    const b = await getAvailableKeyIndices(
      "CLAUDE_CODE_OAUTH_TOKEN",
      2,
      "global",
      null,
      "opus",
      suffixes(POOL_B),
    );
    expect(a.availableIndices).toEqual([0]);
    expect(a.modelBlockedIndices).toEqual([1]);
    expect(b.availableIndices).toEqual([0, 1]);
    expect(b.modelBlockedIndices).toEqual([]);
  });

  test("two pool keys with the same suffix keep the index read: one bench does not bench both", async () => {
    // a-same1 and b-same1 share one status row; a rate limit at index 0 must leave index 1.
    await markKeyRateLimited("MISTRAL_API_KEY", "same1", 0, FUTURE());

    const res = await getAvailable("keyType=MISTRAL_API_KEY&totalKeys=2&keySuffixes=same1,same1");
    expect(res.body).toMatchObject({ availableIndices: [1] });
    // Control: the index read gives the same answer.
    const legacy = await getAvailableKeyIndices("MISTRAL_API_KEY", 2);
    expect(legacy.availableIndices).toEqual([1]);
  });

  test("validation success and a rate-limit clear at global scope reach the key's agent-scoped rows", async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${baseUrl}/api/keys/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const available = () =>
      getAvailable(
        `keyType=DEEPSEEK_API_KEY&totalKeys=2&keySuffixes=${suffixes(POOL_A).join(",")}`,
      );

    // 401 for aaaa1 at agent scope, then OK at global scope.
    const keys = (ok: boolean) => [
      { keyIndex: 1, keySuffix: "aaaa1", ok, ...(ok ? {} : { httpStatus: 401 }) },
    ];
    expect(
      (
        await post("report-validation", {
          keyType: "DEEPSEEK_API_KEY",
          keys: keys(false),
          scope: "agent",
          scopeId: "agent-a",
        })
      ).status,
    ).toBe(200);
    expect((await available()).body).toMatchObject({ rejectedIndices: [1] });
    expect(
      (await post("report-validation", { keyType: "DEEPSEEK_API_KEY", keys: keys(true) })).status,
    ).toBe(200);
    expect((await available()).body).toMatchObject({
      availableIndices: [0, 1],
      rejectedIndices: [],
    });

    // A rate limit on the agent-scoped row, cleared by the worker's global-scope recheck.
    await markKeyRateLimited("DEEPSEEK_API_KEY", "aaaa1", 1, FUTURE(), "agent", "agent-a");
    expect((await available()).body).toMatchObject({ availableIndices: [0] });
    const clear = await post("clear-rate-limit", {
      keyType: "DEEPSEEK_API_KEY",
      keySuffix: "aaaa1",
    });
    expect(((await clear.json()) as { cleared: boolean }).cleared).toBe(true);
    expect((await available()).body).toMatchObject({ availableIndices: [0, 1] });
  });

  test("the route rejects a suffix list that does not match totalKeys", async () => {
    const res = await getAvailable("keyType=OPENAI_API_KEY&totalKeys=3&keySuffixes=hared,aaaa1");
    expect(res.status).toBe(400);
  });

  test("worker key selection skips its own benched key and keeps the other pool's", async () => {
    await markKeyRateLimited("OPENROUTER_API_KEY", "aaaa1", 1, FUTURE());
    await markKeyRateLimited("OPENROUTER_API_KEY", "hared", 0, FUTURE());

    for (let i = 0; i < 10; i++) {
      const envA: Record<string, string | undefined> = { OPENROUTER_API_KEY: POOL_A.join(",") };
      const [selA] = await resolveCredentialPools(envA, {
        apiUrl: baseUrl,
        apiKey: "test",
        provider: "opencode",
        model: "google/gemini-3-flash-preview",
      });
      // Both of A's keys are benched: best-effort fallback.
      expect(selA!.isRateLimitFallback).toBe(true);

      const envB: Record<string, string | undefined> = { OPENROUTER_API_KEY: POOL_B.join(",") };
      const [selB] = await resolveCredentialPools(envB, {
        apiUrl: baseUrl,
        apiKey: "test",
        provider: "opencode",
        model: "google/gemini-3-flash-preview",
      });
      expect(selB!.isRateLimitFallback).toBe(false);
      expect(selB!.index).toBe(1);
      expect(envB.OPENROUTER_API_KEY).toBe("example-key-bbbb2");
    }
  });
});
