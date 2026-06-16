import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import {
  deleteOAuthTokens,
  getOAuthTokens,
  storeOAuthTokens,
  upsertOAuthApp,
} from "../be/db-queries/oauth";
import { _test, stopOAuthKeepalive } from "../oauth/keepalive";

const TEST_DB_PATH = "./test-oauth-keepalive.sqlite";

const originalSlackAlertsChannel = process.env.SLACK_ALERTS_CHANNEL;
function restoreSlackAlertsChannel(): void {
  if (originalSlackAlertsChannel === undefined) {
    delete process.env.SLACK_ALERTS_CHANNEL;
    return;
  }
  process.env.SLACK_ALERTS_CHANNEL = originalSlackAlertsChannel;
}

const testApp = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  authorizeUrl: "https://example.com/oauth/authorize",
  tokenUrl: "https://example.com/oauth/token",
  redirectUri: "http://localhost:3013/callback",
  scopes: "read,write",
};

const originalFetch = globalThis.fetch;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  upsertOAuthApp("linear", testApp);
  upsertOAuthApp("jira", {
    ...testApp,
    tokenUrl: "https://example.com/jira/oauth/token",
  });
});

beforeEach(async () => {
  await stopOAuthKeepalive();
  deleteOAuthTokens("linear");
  deleteOAuthTokens("jira");
  globalThis.fetch = originalFetch;
  restoreSlackAlertsChannel();
  mock.restore();
});

afterAll(async () => {
  await stopOAuthKeepalive();
  globalThis.fetch = originalFetch;
  restoreSlackAlertsChannel();
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("OAuth keepalive", () => {
  test("uses a 12h cadence with a 10m refresh buffer", () => {
    expect(_test.KEEPALIVE_INTERVAL_MS).toBe(12 * 60 * 60 * 1000);
    expect(_test.KEEPALIVE_BUFFER_MS).toBe(10 * 60 * 1000);
  });

  test("skips Slack notification when alerts channel env is unset", async () => {
    delete process.env.SLACK_ALERTS_CHANNEL;
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    await expect(_test.notifySlack("test alert")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "[OAuth Keepalive] SLACK_ALERTS_CHANNEL not set; skipping alert",
    );
  });

  test("stopOAuthKeepalive waits for in-flight Jira refresh persistence", async () => {
    storeOAuthTokens("linear", {
      accessToken: "linear-access",
      refreshToken: "linear-refresh",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    storeOAuthTokens("jira", {
      accessToken: "old-jira-access",
      refreshToken: "old-jira-refresh",
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    });

    let releaseTokenResponse!: () => void;
    const tokenResponseReady = new Promise<void>((resolve) => {
      releaseTokenResponse = resolve;
    });
    let fetchStarted!: () => void;
    const fetchStartedPromise = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });

    globalThis.fetch = mock(async () => {
      fetchStarted();
      await tokenResponseReady;
      return new Response(
        JSON.stringify({
          access_token: "new-jira-access",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "new-jira-refresh",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const keepaliveRun = _test.runKeepalive("manual");
    await fetchStartedPromise;

    let stopResolved = false;
    const stopPromise = stopOAuthKeepalive().then(() => {
      stopResolved = true;
    });

    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(getOAuthTokens("jira")?.refreshToken).toBe("old-jira-refresh");

    releaseTokenResponse();
    await stopPromise;
    await keepaliveRun;

    expect(stopResolved).toBe(true);
    const tokens = getOAuthTokens("jira");
    expect(tokens?.accessToken).toBe("new-jira-access");
    expect(tokens?.refreshToken).toBe("new-jira-refresh");
  });
});
