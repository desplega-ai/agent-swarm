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
import { closeDb, getDb, initDb } from "../be/db";
import { upsertOAuthApp } from "../be/db-queries/oauth";
import { getJiraMetadata } from "../jira/metadata";
import * as wrapperModule from "../oauth/wrapper";

const TEST_DB_PATH = "./test-jira-oauth.sqlite";

// Spy on `exchangeCode` instead of `mock.module(...)` so the real wrapper
// module remains untouched in the test process. mock.module is process-global
// and not restorable per bun's docs ("mock.restore() does not reset the value
// of modules that were overridden with mock.module()") — when this file ran
// before src/tests/oauth-wrapper.test.ts in CI's order, the wrapper stayed
// mocked and broke the wrapper's own unit tests.
const exchangeCodeSpy = spyOn(wrapperModule, "exchangeCode");

const originalFetch = globalThis.fetch;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  upsertOAuthApp("jira", {
    clientId: "client-id",
    clientSecret: "client-secret",
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    redirectUri: "http://localhost:3013/api/trackers/jira/callback",
    scopes: "read:jira-work",
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

const { handleJiraCallback } = await import("../jira/oauth");

beforeEach(() => {
  exchangeCodeSpy.mockClear();
  exchangeCodeSpy.mockImplementation(() =>
    Promise.resolve({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresIn: 3600,
      scope: "read:jira-work",
    }),
  );
  // Wipe metadata between tests to confirm writes happen.
  getDb().query("UPDATE oauth_apps SET metadata = '{}' WHERE provider = 'jira'").run();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("handleJiraCallback", () => {
  test("exchanges code, fetches accessible-resources, persists cloudId+siteUrl", async () => {
    let fetchedUrl: string | undefined;
    let fetchedHeaders: Record<string, string> | undefined;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      fetchedUrl = url;
      fetchedHeaders = init?.headers as Record<string, string> | undefined;
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: "cloud-abc",
              url: "https://example.atlassian.net",
              name: "example",
              scopes: ["read:jira-work"],
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;

    const result = await handleJiraCallback("code-1", "state-1");

    // exchangeCode invoked with our config + code/state
    expect(exchangeCodeSpy).toHaveBeenCalledTimes(1);
    expect(result.accessToken).toBe("access-1");
    expect(result.cloudId).toBe("cloud-abc");
    expect(result.siteUrl).toBe("https://example.atlassian.net");

    // accessible-resources URL hit with the right Authorization
    expect(fetchedUrl).toBe("https://api.atlassian.com/oauth/token/accessible-resources");
    expect(fetchedHeaders?.Authorization).toBe("Bearer access-1");

    // Metadata persisted via updateJiraMetadata
    const meta = getJiraMetadata();
    expect(meta.cloudId).toBe("cloud-abc");
    expect(meta.siteUrl).toBe("https://example.atlassian.net");
  });

  test("throws cleanly when accessible-resources is empty", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    ) as unknown as typeof fetch;

    await expect(handleJiraCallback("code-2", "state-2")).rejects.toThrow(
      /no accessible resources/i,
    );

    // Metadata not persisted
    const meta = getJiraMetadata();
    expect(meta.cloudId).toBeUndefined();
  });

  test("throws cleanly when accessible-resources is non-200", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("oops", { status: 500 })),
    ) as unknown as typeof fetch;

    await expect(handleJiraCallback("code-3", "state-3")).rejects.toThrow(
      /accessible-resources fetch failed/i,
    );
  });

  test("throws when accessible-resources entry is malformed (missing id/url)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ name: "no-id" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(handleJiraCallback("code-4", "state-4")).rejects.toThrow(/malformed entry/i);
  });

  test("picks the FIRST accessible resource (single-workspace v1 contract)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            { id: "cloud-first", url: "https://first.atlassian.net" },
            { id: "cloud-second", url: "https://second.atlassian.net" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ) as unknown as typeof fetch;

    const result = await handleJiraCallback("code-5", "state-5");
    expect(result.cloudId).toBe("cloud-first");
    expect(result.siteUrl).toBe("https://first.atlassian.net");
  });
});
