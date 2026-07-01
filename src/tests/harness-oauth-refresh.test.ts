import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, getSwarmConfigs, initDb, upsertSwarmConfig } from "../be/db";
import { ensureHarnessOAuth } from "../oauth/harness-refresh";
import { resetFetchForTesting, setFetchForTesting } from "../providers/codex-oauth/flow";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types";

const TEST_DB_PATH = "./test-harness-oauth-refresh.sqlite";

function storeCodexSlot(slot: number, creds: CodexOAuthCredentials): void {
  upsertSwarmConfig({
    scope: "global",
    key: `codex_oauth_${slot}`,
    value: JSON.stringify(creds),
    isSecret: true,
  });
}

function getStoredCodexSlot(slot: number): CodexOAuthCredentials {
  const row = getSwarmConfigs({ scope: "global", key: `codex_oauth_${slot}` })[0];
  if (!row) throw new Error(`Missing codex_oauth_${slot}`);
  return JSON.parse(row.value) as CodexOAuthCredentials;
}

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterEach(() => {
  resetFetchForTesting();
  getDb().query("DELETE FROM oauth_refresh_locks").run();
  getDb().query("DELETE FROM swarm_config").run();
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("ensureHarnessOAuth", () => {
  test("returns a fresh Codex credential without refreshing", async () => {
    storeCodexSlot(0, {
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: Date.now() + 60 * 60 * 1000,
      accountId: "acct",
    });

    const fetchSpy = mock(() => Promise.resolve(new Response("unexpected", { status: 500 })));
    setFetchForTesting(fetchSpy);

    const result = await ensureHarnessOAuth("codex", { slot: 0 });

    expect(result.access).toBe("fresh-access");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("serializes concurrent Codex refresh callers before the provider token endpoint", async () => {
    storeCodexSlot(2, {
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
      accountId: "acct",
    });

    const fetchSpy = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    setFetchForTesting(fetchSpy);

    const results = await Promise.all([
      ensureHarnessOAuth("codex", { slot: 2 }),
      ensureHarnessOAuth("codex", { slot: 2 }),
      ensureHarnessOAuth("codex", { slot: 2 }),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.access)).toEqual(["new-access", "new-access", "new-access"]);
    const stored = getStoredCodexSlot(2);
    expect(stored.access).toBe("new-access");
    expect(stored.refresh).toBe("new-refresh");
  });

  test("does not persist a refreshed Codex token when the stored refresh token changed mid-refresh", async () => {
    storeCodexSlot(0, {
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
      accountId: "acct",
    });

    setFetchForTesting(() => {
      storeCodexSlot(0, {
        access: "concurrent-access",
        refresh: "concurrent-refresh",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "acct",
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "stale-access",
            refresh_token: "stale-refresh",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });

    await expect(ensureHarnessOAuth("codex", { slot: 0 })).rejects.toThrow(
      /stored refresh token changed/,
    );
    const stored = getStoredCodexSlot(0);
    expect(stored.access).toBe("concurrent-access");
    expect(stored.refresh).toBe("concurrent-refresh");
  });
});
