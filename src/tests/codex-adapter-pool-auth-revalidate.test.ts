/**
 * Regression coverage for review finding #1 on PR #50: the PRODUCTION Codex
 * pool path bypassed the refresh lock entirely.
 *
 * `resolveCodexOAuthCredentialInfo` (runner.ts) materializes `~/.codex/auth.json`
 * directly from whatever is in the config store — no lock, no expiry check —
 * before the Codex adapter ever runs. `resolveCodexAuthMode` (codex-adapter.ts)
 * used to skip `getValidCodexOAuth()` whenever auth.json was already in
 * `chatgpt` mode, which it always is right after the runner materializes it.
 * That meant an expired pool slot's refresh happened via the spawned Codex
 * CLI reading/writing auth.json directly — entirely outside
 * `/api/oauth/refresh-locks` — reopening the exact race
 * `codex-oauth-refresh-lock.test.ts` closes at the `getValidCodexOAuth()`
 * layer.
 *
 * This suite exercises the actual seam `createInProcessCodexSession` calls
 * (`resolveCodexAuthMode`) against a REAL lock server + SQLite-backed
 * `oauth_refresh_locks` table (migration 077) — the same infrastructure
 * `codex-oauth-refresh-lock.test.ts` uses — so "the pool path now refreshes
 * through the lock" is proven at the adapter boundary, not only via direct
 * calls to `getValidCodexOAuth()`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { closeDb, initDb } from "../be/db";
import { handleOAuthLocks } from "../http/oauth-locks";
import { resolveCodexAuthMode } from "../providers/codex-adapter.js";
import { resetFetchForTesting, setFetchForTesting } from "../providers/codex-oauth/flow.js";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types.js";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types.js";

const TEST_DB_PATH = "./test-codex-adapter-pool-auth-revalidate.sqlite";
const MOCK_API_URL = "http://localhost:3013";
const MOCK_API_KEY = "test-api-key";
const FAKE_HOME = "/home/fake-pool-worker";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");

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

function baseConfig(codexSlot: number | undefined): ProviderSessionConfig {
  return {
    prompt: "",
    systemPrompt: "",
    model: "gpt-5-codex",
    role: "worker",
    agentId: "agent-test",
    taskId: "task-test",
    apiUrl: MOCK_API_URL,
    apiKey: MOCK_API_KEY,
    cwd: "/tmp",
    logFile: "/tmp/codex-test.log",
    codexSlot,
  };
}

/** In-memory `~/.codex/auth.json`, seeded to whatever the runner "materialized". */
function fakeAuthJsonFs(initialContent: string) {
  let file: string | null = initialContent;
  const fs = {
    readFile: async (path: string): Promise<string> => {
      if (path !== `${FAKE_HOME}/.codex/auth.json` || file === null) {
        throw new Error("ENOENT");
      }
      return file;
    },
    mkdir: async (): Promise<undefined> => undefined,
    writeFile: async (path: string, data: string): Promise<void> => {
      expect(path).toBe(`${FAKE_HOME}/.codex/auth.json`);
      file = data;
    },
  };
  return { fs, homedir: () => FAKE_HOME, readCurrent: () => file };
}

/** Wires the config store + lock server, mirroring codex-oauth-refresh-lock.test.ts. */
function installMockTransport(store: { creds: CodexOAuthCredentials }): void {
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (urlStr.startsWith(`${MOCK_API_URL}/api/oauth/refresh-locks/`)) {
      return originalFetch(urlStr.replace(MOCK_API_URL, lockServerOrigin), init);
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

describe("resolveCodexAuthMode — pool path revalidates through the lock", () => {
  it("refreshes an expired pool slot through the lock even though auth.json is already chatgpt mode", async () => {
    const store = {
      creds: {
        access: "at_stale",
        refresh: "rt_gen0",
        expires: Date.now() - 1000, // already expired in the config store
        accountId: "acc-test",
      } satisfies CodexOAuthCredentials,
    };
    installMockTransport(store);

    let exchangeCount = 0;
    setFetchForTesting(async (_url, init) => {
      exchangeCount += 1;
      const params = new URLSearchParams((init?.body as string) ?? "");
      expect(params.get("refresh_token")).toBe("rt_gen0");
      return new Response(
        JSON.stringify({ access_token: "at_gen1", refresh_token: "rt_gen1", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    // Mirrors what runner.ts's `resolveCodexOAuthCredentialInfo` +
    // `materializeCodexAuthJson` wrote to disk BEFORE the adapter runs: a
    // chatgpt-mode auth.json built straight from the (now-stale) slot creds,
    // no lock involved.
    const runnerMaterialized = JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: store.creds.access,
        access_token: store.creds.access,
        refresh_token: store.creds.refresh,
        account_id: store.creds.accountId,
      },
      last_refresh: new Date(store.creds.expires).toISOString(),
    });
    const { fs, homedir, readCurrent } = fakeAuthJsonFs(runnerMaterialized);

    const events: ProviderEvent[] = [];
    const authMode = await resolveCodexAuthMode(baseConfig(0), (e) => events.push(e), {
      homedir,
      fs,
    });

    // The refresh went through the real lock + real /oauth/token exchange —
    // exactly once — instead of being silently skipped because auth.json
    // already reported chatgpt mode.
    expect(exchangeCount).toBe(1);
    expect(authMode).toBe("chatgpt");
    expect(store.creds.access).toBe("at_gen1");
    expect(store.creds.refresh).toBe("rt_gen1");

    // auth.json on disk was rewritten with the freshly-rotated token, not
    // left holding the stale one the runner originally materialized.
    const written = JSON.parse(readCurrent() ?? "{}") as { tokens: { access_token: string } };
    expect(written.tokens.access_token).toBe("at_gen1");
  });

  it("performs exactly ONE exchange when two concurrent adapter resolutions race the same materialized slot", async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(
        JSON.stringify({ access_token: "at_gen1", refresh_token: "rt_gen1", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const runnerMaterialized = JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: store.creds.access,
        access_token: store.creds.access,
        refresh_token: store.creds.refresh,
        account_id: store.creds.accountId,
      },
      last_refresh: new Date(store.creds.expires).toISOString(),
    });

    // Two "spawned sessions" resolving auth against the same slot concurrently
    // — same scenario as two tasks drawing the same pool slot in production.
    const fsA = fakeAuthJsonFs(runnerMaterialized);
    const fsB = fakeAuthJsonFs(runnerMaterialized);

    const [modeA, modeB] = await Promise.all([
      resolveCodexAuthMode(baseConfig(0), () => {}, { homedir: fsA.homedir, fs: fsA.fs }),
      resolveCodexAuthMode(baseConfig(0), () => {}, { homedir: fsB.homedir, fs: fsB.fs }),
    ]);

    expect(exchangeCount).toBe(1);
    expect(modeA).toBe("chatgpt");
    expect(modeB).toBe("chatgpt");
    expect(store.creds.access).toBe("at_gen1");
  });

  it("does not touch a non-pool (codexSlot undefined) auth.json that is already chatgpt mode", async () => {
    let fetchCalled = false;
    globalThis.fetch = async (): Promise<Response> => {
      fetchCalled = true;
      throw new Error("resolveCodexAuthMode should not call the config store for non-pool auth");
    };

    const existingAuthJson = JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "at_local",
        access_token: "at_local",
        refresh_token: "rt_local",
        account_id: "acc-local",
      },
      last_refresh: new Date().toISOString(),
    });
    const { fs, homedir, readCurrent } = fakeAuthJsonFs(existingAuthJson);

    const authMode = await resolveCodexAuthMode(baseConfig(undefined), () => {}, {
      homedir,
      fs,
    });

    expect(authMode).toBe("chatgpt");
    expect(fetchCalled).toBe(false);
    expect(readCurrent()).toBe(existingAuthJson);
  });
});
