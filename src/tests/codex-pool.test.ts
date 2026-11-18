/** Regression coverage for nonzero-slot forwarding through persistCodexOAuth. */

import { afterEach, describe, expect, it } from "bun:test";
import { persistCodexOAuth } from "../providers/codex-oauth/storage.js";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_API_URL = "http://localhost:3013";
const MOCK_API_KEY = "example-test-api-key";
const FUTURE = Date.now() + 3_600_000;

function makeCreds(suffix: string): CodexOAuthCredentials {
  return {
    access: `example-access-${suffix}`,
    refresh: `rt_${suffix}`,
    expires: FUTURE,
    accountId: `acc-${suffix}`,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("persistCodexOAuth slot isolation", () => {
  it("persists refreshed credentials to codex_oauth_2, not codex_oauth_0 or legacy", async () => {
    const capturedPuts: Array<{ key: string; value: unknown }> = [];

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") {
        const body = JSON.parse(init!.body as string) as { key: string; value: unknown };
        capturedPuts.push({ key: body.key, value: body.value });
      }
      return new Response(JSON.stringify({ id: "cfg-ok" }), { status: 200 });
    };

    const refreshedCreds: CodexOAuthCredentials = {
      access: "at_refreshed",
      refresh: "rt_refreshed",
      expires: FUTURE,
      accountId: "acc-slot2",
    };

    // Simulate the adapter calling persistCodexOAuth after a token rotation
    // with the slot that the runner passed in config.codexSlot.
    const pickedSlot = 2;
    await persistCodexOAuth(MOCK_API_URL, MOCK_API_KEY, refreshedCreds, pickedSlot);

    expect(capturedPuts).toHaveLength(1);
    const put = capturedPuts[0]!;

    // Must write to slot 2's key.
    expect(put.key).toBe("codex_oauth_2");
    // Must NOT write to slot 0 or the legacy key.
    expect(put.key).not.toBe("codex_oauth_0");
    expect(put.key).not.toBe("codex_oauth");

    // The written value must be the refreshed creds.
    const stored = JSON.parse(put.value as string) as CodexOAuthCredentials;
    expect(stored.access).toBe("at_refreshed");
    expect(stored.refresh).toBe("rt_refreshed");
  });

  it("refresh-back for slot 1 writes to codex_oauth_1", async () => {
    const capturedKeys: string[] = [];

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") {
        const body = JSON.parse(init!.body as string) as { key: string };
        capturedKeys.push(body.key);
      }
      return new Response(JSON.stringify({ id: "cfg-ok" }), { status: 200 });
    };

    await persistCodexOAuth(MOCK_API_URL, MOCK_API_KEY, makeCreds("slot1-refreshed"), 1);

    expect(capturedKeys).toEqual(["codex_oauth_1"]);
  });
});
