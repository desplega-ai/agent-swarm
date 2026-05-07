/**
 * Regression test for the MCP-only-mode Notion OAuth refresh-config
 * registration bug.
 *
 * Background: `src/notion/oauth.ts` registers a Notion-specific
 * {@link OAuthProviderConfig} into the OAuth provider registry so the refresh
 * path in `src/oauth/ensure-token.ts` reuses Basic auth + JSON body +
 * `Notion-Version` header. In MCP-only entrypoints (`src/stdio.ts`,
 * `src/http/mcp.ts`) — which only import `src/server.ts` plus the per-tool
 * files — nothing in the import graph reaches `src/notion/oauth.ts`, so the
 * top-level registration side-effect alone was insufficient.
 *
 * This test asserts that `createServer()` (the canonical MCP startup
 * entrypoint, used by stdio AND streamable-HTTP transports) explicitly
 * populates the OAuth provider registry with the Notion config, regardless
 * of whether the HTTP tracker route flow has been imported.
 *
 * If this test ever starts failing, MCP-only deployments will silently lose
 * Notion token refresh — the same regression PR #446 round-2 caught.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { upsertOAuthApp } from "../be/db-queries/oauth";
import {
  _clearOAuthProviderConfigRegistry,
  getRegisteredOAuthProviderConfig,
} from "../oauth/provider-config-registry";

const TEST_DB_PATH = "./test-notion-oauth-mcp-registration.sqlite";

beforeAll(() => {
  // initDb has to run before createServer's call to it picks up our chosen
  // test DB path; once the singleton is set, subsequent initDb calls re-use it.
  initDb(TEST_DB_PATH);
  // The registry's builder calls getOAuthApp("notion") — needs an app row.
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
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

beforeEach(() => {
  // Wipe the registry so we can verify createServer() actually re-registers,
  // not just that the registry was populated by some unrelated import in an
  // earlier test file.
  _clearOAuthProviderConfigRegistry();
});

describe("createServer() — populates Notion OAuth provider registry", () => {
  test("Notion config registered after createServer() (no HTTP route imports)", async () => {
    // Sanity check: registry is empty after the clear.
    expect(getRegisteredOAuthProviderConfig("notion")).toBeNull();

    // Dynamic import so module-level imports for the test file don't
    // pre-populate the registry before our clear runs.
    const { createServer } = await import("../server");
    createServer();

    const config = getRegisteredOAuthProviderConfig("notion");
    expect(config).not.toBeNull();
    expect(config?.provider).toBe("notion");
    // The Notion-specific token-endpoint settings — these are exactly what
    // the legacy DB-only reconstruction in `ensure-token.ts` drops, and
    // exactly what the refresh path requires.
    expect(config?.tokenAuthMode).toBe("basic");
    expect(config?.tokenContentType).toBe("json");
    expect(config?.extraTokenHeaders?.["Notion-Version"]).toBeTruthy();
    expect(config?.usePkce).toBe(false);
  });

  test("registerNotionOAuthConfig is idempotent (safe to call twice)", async () => {
    const { registerNotionOAuthConfig } = await import("../notion/oauth");
    registerNotionOAuthConfig();
    registerNotionOAuthConfig();
    const config = getRegisteredOAuthProviderConfig("notion");
    expect(config).not.toBeNull();
    expect(config?.provider).toBe("notion");
  });
});
