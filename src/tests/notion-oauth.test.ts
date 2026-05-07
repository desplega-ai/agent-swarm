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
import { getNotionMetadata } from "../notion/metadata";
import * as wrapperModule from "../oauth/wrapper";

const TEST_DB_PATH = "./test-notion-oauth.sqlite";

const exchangeCodeSpy = spyOn(wrapperModule, "exchangeCode");

const originalFetch = globalThis.fetch;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  upsertOAuthApp("notion", {
    clientId: "notion-client",
    clientSecret: "notion-secret",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    redirectUri: "http://localhost:3013/api/trackers/notion/callback",
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

const { handleNotionCallback, getNotionOAuthConfig, revokeNotionToken } = await import(
  "../notion/oauth"
);
const { initNotion, isNotionEnabled, resetNotion } = await import("../notion/app");

beforeEach(() => {
  exchangeCodeSpy.mockClear();
  exchangeCodeSpy.mockImplementation(() =>
    Promise.resolve({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresIn: undefined,
      scope: undefined,
    }),
  );
  getDb().query("UPDATE oauth_apps SET metadata = '{}' WHERE provider = 'notion'").run();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getNotionOAuthConfig", () => {
  test("returns config with Notion-specific shape", () => {
    const config = getNotionOAuthConfig();
    expect(config).not.toBeNull();
    expect(config!.provider).toBe("notion");
    expect(config!.scopes).toEqual([]);
    expect(config!.tokenAuthMode).toBe("basic");
    expect(config!.tokenContentType).toBe("json");
    expect(config!.usePkce).toBe(false);
    expect(config!.extraTokenHeaders?.["Notion-Version"]).toBeTruthy();
    expect(config!.extraParams).toEqual({ owner: "user" });
    expect(config!.defaultTokenLifetimeMs).toBe(60 * 60 * 1000);
  });
});

describe("handleNotionCallback", () => {
  test("exchanges code, fetches bot identity, persists metadata", async () => {
    let fetchedUrl: string | undefined;
    let fetchedHeaders: Record<string, string> | undefined;
    globalThis.fetch = mock(
      // biome-ignore lint/suspicious/noExplicitAny: fetch typing
      async (url: any, init?: any) => {
        fetchedUrl = String(url);
        fetchedHeaders = init?.headers as Record<string, string>;
        return new Response(
          JSON.stringify({
            id: "bot-uuid-1",
            name: "Test Bot",
            avatar_url: "https://example.com/icon.png",
            bot: {
              owner: { type: "user", user: { id: "user-uuid" } },
              workspace_name: "Test Workspace",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    const result = await handleNotionCallback("auth-code", "auth-state");

    expect(result.accessToken).toBe("access-1");
    expect(result.refreshToken).toBe("refresh-1");
    expect(result.botId).toBe("bot-uuid-1");
    expect(result.workspaceName).toBe("Test Workspace");

    expect(fetchedUrl).toBe("https://api.notion.com/v1/users/me");
    expect(fetchedHeaders!.Authorization).toBe("Bearer access-1");
    expect(fetchedHeaders!["Notion-Version"]).toBeTruthy();

    const meta = getNotionMetadata();
    expect(meta.botId).toBe("bot-uuid-1");
    expect(meta.workspaceName).toBe("Test Workspace");
    expect(meta.workspaceIcon).toBe("https://example.com/icon.png");
    expect(meta.owner).toEqual({ type: "user", user: { id: "user-uuid" } });
  });

  test("propagates error if /users/me fails", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ message: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    await expect(handleNotionCallback("code", "state")).rejects.toThrow(
      /Notion bot-identity fetch failed/,
    );
  });
});

describe("revokeNotionToken", () => {
  test("calls revoke endpoint with Basic auth + JSON body", async () => {
    let fetchedUrl: string | undefined;
    let fetchedInit: RequestInit | undefined;
    globalThis.fetch = mock(
      // biome-ignore lint/suspicious/noExplicitAny: fetch typing
      async (url: any, init?: any) => {
        fetchedUrl = String(url);
        fetchedInit = init;
        return new Response("{}", { status: 200 });
      },
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;

    const ok = await revokeNotionToken("at_to_revoke");
    expect(ok).toBe(true);
    expect(fetchedUrl).toBe("https://api.notion.com/v1/oauth/revoke");
    const headers = fetchedInit!.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Notion-Version"]).toBeTruthy();
    const body = JSON.parse(fetchedInit!.body as string) as { token: string };
    expect(body.token).toBe("at_to_revoke");
  });

  test("returns false on non-2xx", async () => {
    globalThis.fetch = mock(
      async () => new Response("{}", { status: 400 }),
      // biome-ignore lint/suspicious/noExplicitAny: typeof globalThis.fetch
    ) as any;
    const ok = await revokeNotionToken("bad");
    expect(ok).toBe(false);
  });
});

describe("initNotion (clientSecret-empty-bug guard)", () => {
  const originalClientId = process.env.NOTION_CLIENT_ID;
  const originalClientSecret = process.env.NOTION_CLIENT_SECRET;
  const originalDisable = process.env.NOTION_DISABLE;
  const originalEnabled = process.env.NOTION_ENABLED;

  afterEach(() => {
    process.env.NOTION_CLIENT_ID = originalClientId;
    process.env.NOTION_CLIENT_SECRET = originalClientSecret;
    process.env.NOTION_DISABLE = originalDisable;
    process.env.NOTION_ENABLED = originalEnabled;
    resetNotion();
  });

  test("throws when clientId set but clientSecret empty", () => {
    process.env.NOTION_CLIENT_ID = "id";
    process.env.NOTION_CLIENT_SECRET = "";
    process.env.NOTION_DISABLE = undefined;
    delete process.env.NOTION_DISABLE;
    delete process.env.NOTION_ENABLED;
    resetNotion();
    expect(() => initNotion()).toThrow(/NOTION_CLIENT_SECRET is missing or empty/);
  });

  test("throws when clientId set but clientSecret undefined", () => {
    process.env.NOTION_CLIENT_ID = "id";
    delete process.env.NOTION_CLIENT_SECRET;
    delete process.env.NOTION_DISABLE;
    delete process.env.NOTION_ENABLED;
    resetNotion();
    expect(() => initNotion()).toThrow(/NOTION_CLIENT_SECRET is missing or empty/);
  });

  test("no-op when integration disabled (no throw on missing secret)", () => {
    process.env.NOTION_CLIENT_ID = "id";
    process.env.NOTION_CLIENT_SECRET = "";
    process.env.NOTION_DISABLE = "true";
    resetNotion();
    expect(initNotion()).toBe(false);
  });

  test("succeeds with both clientId and clientSecret set", () => {
    process.env.NOTION_CLIENT_ID = "id";
    process.env.NOTION_CLIENT_SECRET = "secret";
    delete process.env.NOTION_DISABLE;
    delete process.env.NOTION_ENABLED;
    resetNotion();
    expect(initNotion()).toBe(true);
    expect(isNotionEnabled()).toBe(true);
  });
});
