/**
 * `POST /api/oauth/keep-warm/codex` — the locked keep-warm refresh sweep
 * (Phase 2.2 of the Codex OAuth pool hardening plan). Reuses the same
 * `getValidCodexOAuth` lock/re-read/persist/quarantine discipline exercised
 * by `codex-oauth-refresh-lock.test.ts`; this suite covers the endpoint's own
 * composition (slot enumeration, bench-skip via KV, per-slot outcome shape).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeDb, initDb, upsertKv } from "../be/db";
import { handleCodexOAuthKeepWarm } from "../http/codex-oauth-keep-warm";
import { handleOAuthLocks } from "../http/oauth-locks";
import { resetFetchForTesting, setFetchForTesting } from "../providers/codex-oauth/flow.js";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types.js";

const TEST_DB_PATH = "./test-codex-oauth-keep-warm.sqlite";

let lockServer: Server;
let lockServerOrigin: string;
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.AGENT_SWARM_API_KEY;

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = "test-api-key";

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
  if (originalApiKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
  else process.env.AGENT_SWARM_API_KEY = originalApiKey;
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetFetchForTesting();
});

function fakeReqRes(): {
  req: IncomingMessage;
  res: ServerResponse;
  captured: { status: number; body: string };
} {
  const req = {
    method: "POST",
    url: "/api/oauth/keep-warm/codex",
    headers: { host: "127.0.0.1:9999" },
  } as unknown as IncomingMessage;

  const captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(chunk?: string) {
      if (chunk) captured.body = chunk;
      return this;
    },
  } as unknown as ServerResponse;

  return { req, res, captured };
}

/** Wires the config store against an in-memory slot map, mirroring the storage-test style. */
function installMockTransport(slots: Map<number, CodexOAuthCredentials>): void {
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (urlStr.includes("/api/oauth/refresh-locks/")) {
      return originalFetch(urlStr.replace(/^https?:\/\/[^/]+/, lockServerOrigin), init);
    }
    if (method === "GET" && urlStr.includes("/api/config/resolved")) {
      const configs = Array.from(slots.entries()).map(([slot, creds]) => ({
        id: `cfg-${slot}`,
        key: `codex_oauth_${slot}`,
        value: JSON.stringify(creds),
      }));
      return new Response(JSON.stringify({ configs }), { status: 200 });
    }
    if (method === "PUT" && urlStr.includes("/api/config")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as { key: string; value: string };
      const match = /^codex_oauth_(\d+)$/.exec(body.key);
      if (match) slots.set(Number(match[1]), JSON.parse(body.value) as CodexOAuthCredentials);
      return new Response(JSON.stringify({ id: body.key }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${urlStr}`);
  };
}

describe("POST /api/oauth/keep-warm/codex", () => {
  it("reports 'warm' for a slot younger than maxAgeMs (no refresh)", async () => {
    const slots = new Map<number, CodexOAuthCredentials>([
      [
        0,
        {
          access: "at_fresh",
          refresh: "rt_fresh",
          expires: Date.now() + 9 * 24 * 60 * 60 * 1000, // issued ~1 day ago (10d TTL)
          accountId: "acc-fresh",
        },
      ],
    ]);
    installMockTransport(slots);
    setFetchForTesting(async () => {
      throw new Error("no /oauth/token exchange should happen for a warm slot");
    });

    const { req, res, captured } = fakeReqRes();
    const handled = await handleCodexOAuthKeepWarm(req, res, [
      "api",
      "oauth",
      "keep-warm",
      "codex",
    ]);

    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as { results: Array<Record<string, unknown>> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ slot: 0, outcome: "warm" });
  });

  it("refreshes and reports 'refreshed' for a slot older than maxAgeMs", async () => {
    const slots = new Map<number, CodexOAuthCredentials>([
      [
        1,
        {
          access: "at_old",
          refresh: "rt_old",
          expires: Date.now() + 1 * 24 * 60 * 60 * 1000, // issued ~9 days ago (10d TTL)
          accountId: "acc-old",
        },
      ],
    ]);
    installMockTransport(slots);
    setFetchForTesting(async () => {
      return new Response(
        JSON.stringify({
          access_token: "at_keepwarm",
          refresh_token: "rt_keepwarm",
          expires_in: 864000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const { req, res, captured } = fakeReqRes();
    await handleCodexOAuthKeepWarm(req, res, ["api", "oauth", "keep-warm", "codex"]);

    const body = JSON.parse(captured.body) as { results: Array<Record<string, unknown>> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ slot: 1, outcome: "refreshed" });
    expect(slots.get(1)?.access).toBe("at_keepwarm");
  });

  it("skips a slot with an active codex-auth-watch bench marker", async () => {
    const keySuffix = "c-old"; // last 5 of accountId (no chatgpt_user_id in this fixture's access token)
    upsertKv({
      namespace: "codex-auth-watch",
      key: `bench:${keySuffix}`,
      value: "1",
      valueType: "string",
    });

    const slots = new Map<number, CodexOAuthCredentials>([
      [
        2,
        {
          access: "at_benched",
          refresh: "rt_benched",
          expires: Date.now() + 1 * 24 * 60 * 60 * 1000,
          accountId: "acc-old", // suffix "cc-old" matches the bench marker above
        },
      ],
    ]);
    installMockTransport(slots);
    setFetchForTesting(async () => {
      throw new Error("no /oauth/token exchange should happen for a benched slot");
    });

    const { req, res, captured } = fakeReqRes();
    await handleCodexOAuthKeepWarm(req, res, ["api", "oauth", "keep-warm", "codex"]);

    const body = JSON.parse(captured.body) as { results: Array<Record<string, unknown>> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ slot: 2, outcome: "skipped-benched" });
  });

  it("reports 'failed' with the reason when a slot's refresh is rejected, without aborting the sweep", async () => {
    const slots = new Map<number, CodexOAuthCredentials>([
      [
        0,
        {
          access: "at_old0",
          refresh: "rt_old0",
          expires: Date.now() + 1 * 24 * 60 * 60 * 1000,
          accountId: "acc-zero",
        },
      ],
      [
        1,
        {
          access: "at_fresh1",
          refresh: "rt_fresh1",
          expires: Date.now() + 9 * 24 * 60 * 60 * 1000,
          accountId: "acc-one",
        },
      ],
    ]);
    installMockTransport(slots);
    setFetchForTesting(async () => new Response("invalid_grant", { status: 401 }));

    const { req, res, captured } = fakeReqRes();
    await handleCodexOAuthKeepWarm(req, res, ["api", "oauth", "keep-warm", "codex"]);

    const body = JSON.parse(captured.body) as { results: Array<Record<string, unknown>> };
    expect(body.results).toHaveLength(2);
    const slot0 = body.results.find((r) => r.slot === 0);
    expect(slot0?.outcome).toBe("failed");
    expect(String(slot0?.reason)).toContain("refresh rejected");
    // Slot 1 (warm, no refresh needed) still gets swept despite slot 0's failure.
    const slot1 = body.results.find((r) => r.slot === 1);
    expect(slot1?.outcome).toBe("warm");
  });

  it("returns an empty result set when no slots are configured", async () => {
    installMockTransport(new Map());
    const { req, res, captured } = fakeReqRes();
    await handleCodexOAuthKeepWarm(req, res, ["api", "oauth", "keep-warm", "codex"]);

    const body = JSON.parse(captured.body) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });

  it("does not match unrelated paths", async () => {
    const { req, res } = fakeReqRes();
    const handled = await handleCodexOAuthKeepWarm(req, res, [
      "api",
      "oauth",
      "refresh-locks",
      "x",
    ]);
    expect(handled).toBe(false);
  });
});
