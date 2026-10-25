import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  closeDb,
  createAgent,
  createUser,
  getAvailableKeyIndices,
  getDbClient,
  getSwarmConfigs,
  initDb,
  markKeyRateLimited,
  recordKeyAuthFailure,
  recordKeyUsage,
  upsertKv,
  upsertSwarmConfig,
} from "../be/db";
import { mintAgentToken, mintToken } from "../be/users";
import { type CodexAccountsResponse, handleCodexOAuthAccounts } from "../http/codex-oauth-accounts";
import { _autoReloadStatsForTests, _resetAutoReloadForTests, handleCore } from "../http/core";
import { getPathSegments, parseQueryParams } from "../http/utils";

const API_KEY = "example-codex-accounts-operator";
let workerToken: string;
let leadToken: string;
let workerId: string;
let leadId: string;

function credentials(userId: string, profile?: Record<string, unknown>) {
  const payload = {
    "https://api.openai.com/auth": {
      chatgpt_user_id: userId,
      chatgpt_account_id: "example-shared-workspace",
      chatgpt_plan_type: "team",
    },
    ...(profile ? { "https://api.openai.com/profile": profile } : {}),
  };
  return {
    access: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`,
    refresh: `example-refresh-${userId}`,
    accountId: "example-shared-workspace",
    expires: Date.now() + 3_600_000,
  };
}

async function store(key: string, value: unknown = credentials(`user-${key}`)) {
  return await upsertSwarmConfig({
    scope: "global",
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
    isSecret: true,
  });
}

async function request(path = "", method = "GET", bearer = API_KEY, agentId?: string) {
  const url = `/api/codex-oauth/accounts${path}`;
  const req = Object.assign(Readable.from([]), {
    method,
    url,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(agentId ? { "x-agent-id": agentId } : {}),
    },
  }) as IncomingMessage;
  let status = 200;
  let body = "";
  const res = {
    setHeader: () => {},
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: string) => {
      body += chunk ?? "";
    },
  } as unknown as ServerResponse;
  if (!(await handleCore(req, res, agentId, API_KEY))) {
    const handled = await handleCodexOAuthAccounts(
      req,
      res,
      getPathSegments(url),
      parseQueryParams(url),
    );
    expect(handled).toBe(true);
  }
  return new Response(body, { status });
}

async function list(): Promise<CodexAccountsResponse> {
  const response = await request();
  expect(response.status).toBe(200);
  return (await response.json()) as CodexAccountsResponse;
}

beforeAll(async () => {
  initDb(":memory:");
  workerId = (await createAgent({ name: "account-worker", isLead: false, status: "idle" })).id;
  leadId = (await createAgent({ name: "account-lead", isLead: true, status: "idle" })).id;
  workerToken = (await mintAgentToken(workerId)).plaintext;
  leadToken = (await mintAgentToken(leadId)).plaintext;
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM swarm_config");
  await getDbClient().run("DELETE FROM api_key_status");
  await getDbClient().run("DELETE FROM kv_entries");
});

afterEach(() => _resetAutoReloadForTests());

afterAll(() => {
  _resetAutoReloadForTests();
  closeDb();
});

describe("Codex account HTTP routes", () => {
  test("lists slots in numeric order with metadata and no credentials", async () => {
    const account = credentials("grant-first", { email: "first@example.test" });
    await store("codex_oauth_10", credentials("grant-tenth"));
    await store("codex_oauth_2", account);
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: workerId,
      key: "codex_oauth_1",
      value: JSON.stringify(credentials("agent-only")),
      isSecret: true,
    });
    await recordKeyUsage("CODEX_OAUTH", "first", 2, null);
    const response = await request();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(account.access);
    expect(text).not.toContain(account.refresh);
    expect(text).not.toContain(account.accountId);
    expect(JSON.parse(text)).toEqual({
      accounts: [
        {
          slot: 2,
          configKey: "codex_oauth_2",
          legacy: false,
          suffix: "first",
          plan: "team",
          email: "first@example.test",
          status: "ok",
        },
        {
          slot: 10,
          configKey: "codex_oauth_10",
          legacy: false,
          suffix: "tenth",
          plan: "team",
          email: null,
          status: "unchecked",
        },
      ],
    });
  });

  test("uses the legacy row only when slot zero does not exist", async () => {
    await store("codex_oauth");
    expect((await list()).accounts).toMatchObject([
      { slot: 0, legacy: true, configKey: "codex_oauth" },
    ]);
    await store("codex_oauth_0");
    expect((await list()).accounts).toMatchObject([
      { slot: 0, legacy: false, configKey: "codex_oauth_0" },
    ]);
  });

  test("lists malformed credentials as accounts that need login", async () => {
    await store("codex_oauth_0", "not-json");
    await store("codex_oauth_1", { access: 42, accountId: "example" });
    await store("codex_oauth_2", "null");
    const { accounts } = await list();
    expect(accounts).toHaveLength(3);
    for (const account of accounts) {
      expect(account).toMatchObject({
        suffix: null,
        plan: null,
        email: null,
        status: "needs_login",
      });
    }
  });

  test.each([
    { refresh: undefined },
    { refresh: "" },
    { expires: undefined },
    { expires: "invalid" },
    { expires: null },
  ])("requires a refresh token and numeric expiry: %j", async (invalid) => {
    await store("codex_oauth_0", { ...credentials("grant-invalid"), ...invalid });
    expect((await list()).accounts).toMatchObject([
      { slot: 0, suffix: null, plan: null, email: null, status: "needs_login" },
    ]);
  });

  test("rejects a non-finite expiry", async () => {
    const value = JSON.stringify(credentials("grant-invalid")).replace(
      /"expires":\d+/,
      '"expires":1e999',
    );
    await store("codex_oauth_0", value);
    expect((await list()).accounts).toMatchObject([
      { slot: 0, suffix: null, plan: null, email: null, status: "needs_login" },
    ]);
  });

  test("ignores unrelated unreadable secrets and permits removal of an unreadable account", async () => {
    await store("codex_oauth_0");
    for (const key of ["UNRELATED_SECRET", "codex_oauth_1"]) {
      await store(key);
      await getDbClient().run("UPDATE swarm_config SET value = ?, encrypted = 1 WHERE key = ?", [
        "invalid-ciphertext",
        key,
      ]);
    }
    const { accounts } = await list();
    expect(accounts).toHaveLength(2);
    expect(accounts[1]).toMatchObject({ slot: 1, suffix: null, status: "needs_login" });
    const response = await request("/1", "DELETE");
    expect(response.status).toBe(200);
    expect((await response.json()).accounts).toHaveLength(1);
  });

  test("shows active KV and status auth benches without treating ordinary rate limits as auth failures", async () => {
    await store("codex_oauth_0", credentials("grant-bench"));
    await store("codex_oauth_1", credentials("grant-authf"));
    await store("codex_oauth_2", credentials("grant-ratel"));
    await upsertKv({
      namespace: "codex-auth-watch",
      key: "bench:bench",
      valueType: "string",
      value: "1",
    });
    await recordKeyAuthFailure("CODEX_OAUTH", "authf", 1);
    await recordKeyAuthFailure("CODEX_OAUTH", "authf", 1);
    await getDbClient().run("DELETE FROM kv_entries WHERE key = 'bench:authf'");
    await markKeyRateLimited(
      "CODEX_OAUTH",
      "ratel",
      2,
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    expect((await list()).accounts.map((account) => account.status)).toEqual([
      "needs_login",
      "needs_login",
      "ok",
    ]);
  });

  test("ignores expired KV markers and status records from other scopes", async () => {
    await store("codex_oauth_0", credentials("grant-clear"));
    await upsertKv({
      namespace: "codex-auth-watch",
      key: "bench:clear",
      valueType: "string",
      value: "1",
      expiresAt: Date.now() - 1,
    });
    await recordKeyAuthFailure("CODEX_OAUTH", "clear", 0, "agent", workerId);
    expect((await list()).accounts[0]?.status).toBe("unchecked");
  });

  test("requires authentication and permission to read all secrets", async () => {
    await store("codex_oauth_0");
    expect((await request("", "GET", "invalid")).status).toBe(401);
    const denied = await request("", "GET", workerToken);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("codex_oauth_0");
    expect((await request("", "GET", leadToken)).status).toBe(200);
    expect((await request("", "GET", API_KEY, workerId)).status).toBe(200);
  });

  test("deletes only the selected slot and schedules config side effects", async () => {
    await store("codex_oauth_0");
    await store("codex_oauth_2");
    const response = await request("/2", "DELETE");
    expect(response.status).toBe(200);
    expect((await response.json()).accounts).toMatchObject([{ slot: 0 }]);
    expect(await getSwarmConfigs({ scope: "global", key: "codex_oauth_2" })).toEqual([]);
    expect(_autoReloadStatsForTests().pending).toBe(true);
  });

  test("a sign-in in a freed slot does not inherit the removed account's auth bench", async () => {
    await store("codex_oauth_0", credentials("grant-keep0"));
    await store("codex_oauth_1", credentials("grant-gone1"));
    await recordKeyAuthFailure("CODEX_OAUTH", "gone1", 1);
    await recordKeyAuthFailure("CODEX_OAUTH", "gone1", 1);
    expect((await getAvailableKeyIndices("CODEX_OAUTH", 2)).availableIndices).toEqual([0]);
    expect((await request("/1", "DELETE")).status).toBe(200);
    await store("codex_oauth_1", credentials("grant-fresh"));
    expect((await getAvailableKeyIndices("CODEX_OAUTH", 2)).availableIndices).toEqual([0, 1]);
    expect((await list()).accounts.map((account) => account.status)).toEqual([
      "unchecked",
      "unchecked",
    ]);
  });

  test("deletes the legacy slot zero and keeps it when the numbered row exists", async () => {
    await store("codex_oauth");
    expect((await request("/0", "DELETE")).status).toBe(200);
    expect(await getSwarmConfigs({ scope: "global", key: "codex_oauth" })).toEqual([]);
    await store("codex_oauth");
    await store("codex_oauth_0");
    const response = await request("/0", "DELETE");
    expect(response.status).toBe(200);
    expect((await response.json()).accounts).toMatchObject([{ slot: 0, legacy: true }]);
    expect(await getSwarmConfigs({ scope: "global", key: "codex_oauth_0" })).toEqual([]);
  });

  test("returns 404 for missing slots and rejects invalid slot numbers", async () => {
    expect((await request("/1", "DELETE")).status).toBe(404);
    for (const slot of ["-1", "1.5", "nope", "101"]) {
      expect((await request(`/${slot}`, "DELETE")).status).toBe(400);
    }
    expect(_autoReloadStatsForTests().pending).toBe(false);
  });

  test("a user who may delete config but not read secrets cannot remove an account", async () => {
    await store("codex_oauth_0", credentials("grant-keep0", { email: "keep@example.com" }));
    await store("codex_oauth_1");
    const user = await createUser({ name: "Delete-only user" });
    const token = await mintToken(user.id, "delete-only", { kind: "operator", id: "codex-test" });
    // A new user starts as admin. Replace that with a role that grants only the delete.
    await getDbClient().run("DELETE FROM principal_roles WHERE principalId = ?", [user.id]);
    await getDbClient().run(
      "INSERT INTO roles (id, name) VALUES ('codex-delete-only', 'codex-delete-only')",
    );
    await getDbClient().run(
      "INSERT INTO role_permissions (roleId, verb) VALUES ('codex-delete-only', 'config.delete.any')",
    );
    await getDbClient().run(
      "INSERT INTO principal_roles (principalType, principalId, roleId) VALUES ('user', ?, 'codex-delete-only')",
      [user.id],
    );
    const previous = process.env.RBAC_ENABLED;
    process.env.RBAC_ENABLED = "true";
    try {
      const response = await request("/1", "DELETE", token.plaintext);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("keep@example.com");
      expect((await getSwarmConfigs({ scope: "global", key: "codex_oauth_1" })).length).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.RBAC_ENABLED;
      else process.env.RBAC_ENABLED = previous;
    }
  });

  test("denies worker deletion and identity spoofing while allowing the lead", async () => {
    await store("codex_oauth_0");
    expect((await request("/0", "DELETE", workerToken)).status).toBe(403);
    expect((await request("/0", "DELETE", workerToken, leadId)).status).toBe(403);
    expect((await getSwarmConfigs({ scope: "global", key: "codex_oauth_0" })).length).toBe(1);
    expect((await request("/0", "DELETE", leadToken)).status).toBe(200);
  });
});
