import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  closeDb,
  createUser,
  getAvailableKeyIndices,
  getDbClient,
  getSwarmConfigs,
  initDb,
  recordKeyValidation,
  upsertSwarmConfig,
} from "../be/db";
import { handleConfig } from "../http/config";
import {
  __resetInjectedEnvTracking,
  flushPendingIntegrationsReload,
  loadGlobalConfigsIntoEnv,
} from "../http/core";
import { handlePoolKeys, type PoolKeysResponse } from "../http/pool-keys";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { CREDENTIAL_POOL_VARS } from "../utils/credentials";
import { type HttpRequestAuth, setRequestAuth } from "../utils/request-auth-context";

const API_KEY = "example-pool-test-operator";
const KEY = "ANTHROPIC_API_KEY";
const first = "example-provider-key-first";
const second = "example-provider-key-secnd";
const envKeys = [...CREDENTIAL_POOL_VARS, "OPENROUTER_BASE_URL", "ANTHROPIC_BASE_URL"];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let providerCalls: Array<{ url: string; init?: RequestInit }>;
let providerFetch: (input: string, init?: RequestInit) => Promise<Response>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

type Principal = boolean | HttpRequestAuth;

async function call(
  path: string,
  method: string,
  body?: unknown,
  guest: Principal = false,
): Promise<Response> {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as IncomingMessage;
  Object.assign(req, { method, url: path, headers: { "content-type": "application/json" } });
  setRequestAuth(
    req,
    typeof guest === "object"
      ? guest
      : guest
        ? { kind: "guest" }
        : { kind: "operator", fingerprint: API_KEY },
  );
  let status = 200;
  let text = "";
  const res = {
    setHeader() {},
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: string) {
      text += chunk ?? "";
    },
  } as unknown as ServerResponse;
  const segments = getPathSegments(path);
  const query = parseQueryParams(path);
  const handled =
    (await handlePoolKeys(req, res, segments, query)) ||
    (await handleConfig(req, res, segments, query));
  expect(handled).toBe(true);
  return new Response(text, { status });
}

async function request(
  method = "GET",
  query = `?key=${KEY}`,
  body?: unknown,
  guest: Principal = false,
) {
  const response = await call(`/api/config/pool-keys${query}`, method, body, guest);
  const text = await response.text();
  expect(text).not.toContain(first);
  expect(text).not.toContain(second);
  return { status: response.status, body: JSON.parse(text) };
}

async function store(value = first) {
  return await upsertSwarmConfig({
    scope: "global",
    key: KEY,
    value,
    isSecret: true,
    description: "Keep this description",
    exportToEnv: false,
  });
}

async function pool(): Promise<PoolKeysResponse> {
  return (await request()).body;
}

beforeAll(() => {
  initDb(":memory:");
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM swarm_config");
  await getDbClient().run("DELETE FROM api_key_status");
  for (const key of envKeys) delete process.env[key];
  __resetInjectedEnvTracking();
  providerCalls = [];
  providerFetch = async () => new Response("{}", { status: 200 });
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = String(input);
    providerCalls.push({ url, init });
    return providerFetch(url, init);
  }) as typeof fetch);
});

afterEach(async () => {
  await flushPendingIntegrationsReload();
  fetchSpy.mockRestore();
});

afterAll(() => {
  closeDb();
  __resetInjectedEnvTracking();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("credential pool reads", () => {
  test("lists suffixes with all four statuses and rejection precedence", async () => {
    const limited = "example-provider-key-limit";
    const unchecked = "example-provider-key-newww";
    await store([first, second, limited, unchecked].join(","));
    await recordKeyValidation(KEY, [
      { keyIndex: 0, keySuffix: first.slice(-5), ok: true },
      { keyIndex: 1, keySuffix: second.slice(-5), ok: false, httpStatus: 401 },
      { keyIndex: 2, keySuffix: limited.slice(-5), ok: true },
    ]);
    const until = new Date(Date.now() + 60_000).toISOString();
    await getDbClient().run(
      "UPDATE api_key_status SET status = 'rate_limited', rateLimitedUntil = ? WHERE keySuffix IN (?, ?)",
      [until, second.slice(-5), limited.slice(-5)],
    );
    const result = await pool();
    expect(result).toMatchObject({ key: KEY, source: "stored", readOnly: false });
    expect(result.keys.map((key) => key.status)).toEqual([
      "ok",
      "rejected",
      "rate_limited",
      "unchecked",
    ]);
    expect(result.keys[1]).toMatchObject({ error: "HTTP 401", rateLimitedUntil: until });
    expect(result.keys[1]!.checkedAt).not.toBeNull();
    expect(result.keys[3]).toMatchObject({ error: null, checkedAt: null, rateLimitedUntil: null });
    expect(JSON.stringify(result)).not.toContain(limited);
    expect(JSON.stringify(result)).not.toContain(unchecked);
  });

  test("env-only values are read-only and stored values take precedence", async () => {
    process.env[KEY] = first;
    expect(await pool()).toMatchObject({
      source: "env",
      readOnly: true,
      keys: [{ suffix: "first" }],
    });
    await store(second);
    expect(await pool()).toMatchObject({
      source: "stored",
      readOnly: false,
      keys: [{ suffix: "secnd" }],
    });
  });

  test("an absent value has no keys", async () => {
    expect(await pool()).toEqual({ key: KEY, source: "none", readOnly: false, keys: [] });
  });

  test.each(["NOT_A_POOL", "CODEX_OAUTH"])("rejects variable %s", async (key) => {
    expect((await request("GET", `?key=${key}`)).status).toBe(400);
    expect((await request("POST", "", { key, value: first })).status).toBe(400);
    expect((await request("DELETE", `?key=${key}&index=0&suffix=first`)).status).toBe(400);
  });

  test("a caller without secret read permission receives 403", async () => {
    await store();
    expect((await request("GET", `?key=${KEY}`, undefined, true)).status).toBe(403);
  });

  test("stored validation errors cannot disclose a key", async () => {
    await store();
    await recordKeyValidation(KEY, [
      { keyIndex: 0, keySuffix: "first", ok: false, httpStatus: 401 },
    ]);
    await getDbClient().run("UPDATE api_key_status SET lastValidationError = ?", [
      `Rejected ${first}`,
    ]);
    expect((await pool()).keys[0]!.error).toContain("[REDACTED");
  });
});

describe("credential pool additions", () => {
  test("tests one key, appends it, records a pass, and preserves config metadata", async () => {
    await store();
    await recordKeyValidation(KEY, [
      { keyIndex: 0, keySuffix: "first", ok: false, httpStatus: 401 },
    ]);
    const result = await request("POST", "", { key: KEY, value: second });
    expect(result.status).toBe(200);
    expect(result.body.checks).toEqual([
      { suffix: "secnd", result: "verified", httpStatus: null, error: null },
    ]);
    expect(result.body.keys.map((key: { status: string }) => key.status)).toEqual([
      "rejected",
      "ok",
    ]);
    expect((await pool()).keys[1]!.status).toBe("ok");
    expect(providerCalls).toHaveLength(1);
    expect((await getSwarmConfigs({ scope: "global", key: KEY }))[0]).toMatchObject({
      value: `${first},${second}`,
      isSecret: true,
      description: "Keep this description",
      exportToEnv: false,
    });
  });

  test("adds two comma-separated keys after trimming and dropping empty parts", async () => {
    const result = await request("POST", "", { key: KEY, value: ` , ${first}, ${second}, ` });
    expect(result.status).toBe(200);
    expect(result.body.keys.map((key: { suffix: string }) => key.suffix)).toEqual([
      "first",
      "secnd",
    ]);
    expect(providerCalls).toHaveLength(2);
  });

  test.each(["", " , , "])("rejects empty input %s", async (value) => {
    expect(await request("POST", "", { key: KEY, value })).toMatchObject({
      status: 400,
      body: { error: "Enter a key." },
    });
    expect(providerCalls).toHaveLength(0);
  });

  test.each([
    "inner space",
    "inner\ttab",
    "inner\nline",
  ])("rejects whitespace inside %s", async (value) => {
    expect(await request("POST", "", { key: KEY, value })).toMatchObject({
      status: 400,
      body: { error: "A key cannot contain spaces or line breaks." },
    });
    expect(providerCalls).toHaveLength(0);
  });

  test("rejects a duplicate already stored", async () => {
    await store();
    expect(await request("POST", "", { key: KEY, value: first })).toMatchObject({
      status: 409,
      body: { error: "The key ending first is already in the pool." },
    });
    expect(providerCalls).toHaveLength(0);
  });

  test("rejects a duplicate inside the input", async () => {
    expect((await request("POST", "", { key: KEY, value: `${first},${first}` })).status).toBe(409);
    expect(providerCalls).toHaveLength(0);
  });

  test("a 401 rejects the entire batch and scrubs provider errors", async () => {
    providerFetch = async (_url, init) =>
      new Response(`Rejected ${new Headers(init?.headers).get("x-api-key")}`, { status: 401 });
    const result = await request("POST", "", { key: KEY, value: `${first},${second}` });
    expect(result.status).toBe(422);
    expect(result.body.error).toBe(
      "The key ending first was rejected (HTTP 401). Nothing was saved.",
    );
    expect(result.body.checks[0]).toMatchObject({ result: "rejected", httpStatus: 401 });
    expect(await getSwarmConfigs({ scope: "global", key: KEY })).toEqual([]);
    expect(await getDbClient().query("SELECT * FROM api_key_status")).toEqual([]);
  });

  test("a provider error cannot expose a long key prefix", async () => {
    const value = "example-long-provider-key-".repeat(12);
    providerFetch = async () => new Response(`Rejected ${value}`, { status: 401 });
    const result = await request("POST", "", { key: KEY, value });
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).not.toContain(value.slice(0, 40));
    expect(result.body.checks[0].error).toContain("[REDACTED");
  });

  test.each([403, 429, 500, 503])("saves after HTTP %s with not_tested", async (status) => {
    providerFetch = async () => new Response("Unavailable", { status });
    const result = await request("POST", "", { key: KEY, value: first });
    expect(result.status).toBe(200);
    expect(result.body.checks[0]).toMatchObject({ result: "not_tested", httpStatus: status });
    expect(result.body.keys[0].status).toBe("unchecked");
    expect((await getSwarmConfigs({ scope: "global", key: KEY }))[0]!.value).toBe(first);
  });

  test("saves after a timeout with not_tested", async () => {
    providerFetch = async () => {
      throw new DOMException("Timed out", "TimeoutError");
    };
    const result = await request("POST", "", { key: KEY, value: first });
    expect(result.status).toBe(200);
    expect(result.body.checks[0]).toMatchObject({ result: "not_tested", httpStatus: null });
  });

  test.each([
    "DEVIN_API_KEY",
    "AMP_API_KEY",
    "CURSOR_API_KEY",
  ])("does not probe %s", async (key) => {
    const result = await request("POST", "", { key, value: first });
    expect(result.status).toBe(200);
    expect(result.body.checks[0].result).toBe("not_tested");
    expect(providerCalls).toHaveLength(0);
  });

  test("env pools cannot be changed", async () => {
    process.env[KEY] = first;
    for (const method of ["POST", "DELETE"]) {
      const result = await request(method, `?key=${KEY}&index=0&suffix=first`, {
        key: KEY,
        value: second,
      });
      expect(result).toMatchObject({
        status: 409,
        body: { error: "These keys come from the deployment env. Change them there." },
      });
    }
    expect(providerCalls).toHaveLength(0);
  });

  test("guests cannot add or remove keys", async () => {
    await store();
    expect((await request("POST", "", { key: KEY, value: second }, true)).status).toBe(403);
    expect(
      (await request("DELETE", `?key=${KEY}&index=0&suffix=first`, undefined, true)).status,
    ).toBe(403);
    expect(providerCalls).toHaveLength(0);
  });

  test("a config admin who cannot read secrets cannot add or remove keys", async () => {
    await store();
    const user = await createUser({ name: "Config writer without secret read" });
    // A new user starts as admin. Replace that with a role that grants only config writes.
    await getDbClient().run("DELETE FROM principal_roles WHERE principalId = ?", [user.id]);
    await getDbClient().run("INSERT INTO roles (id, name) VALUES ('pool-writer', 'pool-writer')");
    for (const verb of ["config.write.any", "config.delete.any"]) {
      await getDbClient().run(
        "INSERT INTO role_permissions (roleId, verb) VALUES ('pool-writer', ?)",
        [verb],
      );
    }
    await getDbClient().run(
      "INSERT INTO principal_roles (principalType, principalId, roleId) VALUES ('user', ?, 'pool-writer')",
      [user.id],
    );
    const writer: HttpRequestAuth = { kind: "user", userId: user.id, user };
    const previous = process.env.RBAC_ENABLED;
    process.env.RBAC_ENABLED = "true";
    try {
      expect((await request("POST", "", { key: KEY, value: second }, writer)).status).toBe(403);
      expect(
        (await request("DELETE", `?key=${KEY}&index=0&suffix=first`, undefined, writer)).status,
      ).toBe(403);
    } finally {
      if (previous === undefined) delete process.env.RBAC_ENABLED;
      else process.env.RBAC_ENABLED = previous;
    }
    expect(providerCalls).toHaveLength(0);
    expect((await getSwarmConfigs({ scope: "global", key: KEY }))[0]?.value).toBe(first);
  });

  test("rechecks duplicates after a probe without holding the write transaction", async () => {
    providerFetch = async () => {
      await store(first);
      return new Response("{}", { status: 200 });
    };
    expect((await request("POST", "", { key: KEY, value: first })).status).toBe(409);
    expect((await getSwarmConfigs({ scope: "global", key: KEY }))[0]!.value).toBe(first);
  });

  test("an unrelated unreadable secret does not prevent adding a pool key", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "UNRELATED_SECRET",
      value: "unused",
      isSecret: true,
    });
    await getDbClient().run(
      "UPDATE swarm_config SET value = 'invalid-ciphertext', encrypted = 1 WHERE key = 'UNRELATED_SECRET'",
    );
    const result = await request("POST", "", { key: KEY, value: first });
    expect(result.status).toBe(200);
    // Remove the damaged fixture before the normal reload after this test.
    await getDbClient().run("DELETE FROM swarm_config WHERE key = 'UNRELATED_SECRET'");
  });

  test("uses a stored provider URL and disables redirects", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "OPENROUTER_BASE_URL",
      value: "https://gateway.example/v1",
    });
    const result = await request("POST", "", { key: "OPENROUTER_API_KEY", value: first });
    expect(result.status).toBe(200);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({
      url: "https://gateway.example/v1/key",
      init: { redirect: "manual" },
    });
  });

  test("a null baseUrl checks at the provider default while a gateway URL is stored", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "OPENROUTER_BASE_URL",
      value: "https://gateway.example/v1",
    });
    const body = { key: "OPENROUTER_API_KEY", value: first, baseUrl: null };
    expect((await request("POST", "", body)).status).toBe(200);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.url).toStartWith("https://openrouter.ai/");
  });

  test("an Anthropic key behind a gateway is checked at the gateway", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://gateway.example";
    const result = await request("POST", "", { key: KEY, value: first });
    expect(result.status).toBe(200);
    expect(result.body.checks[0]?.result).toBe("verified");
    expect(providerCalls.map((call) => call.url)).toEqual(["https://gateway.example/v1/models"]);
  });

  test("the old PUT config route still saves a whole pool", async () => {
    const response = await call("/api/config", "PUT", {
      scope: "global",
      key: KEY,
      value: `${first},${second}`,
      isSecret: true,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(first);
    expect((await pool()).keys).toHaveLength(2);
    expect(providerCalls).toHaveLength(0);
  });
});

describe("credential pool removal", () => {
  test("removes the member at the matching index and suffix", async () => {
    await store(`${first},${second}`);
    expect(await request("DELETE", `?key=${KEY}&index=0&suffix=first`)).toMatchObject({
      status: 200,
      body: { source: "stored", keys: [{ index: 0, suffix: "secnd" }] },
    });
    expect((await getSwarmConfigs({ scope: "global", key: KEY }))[0]!.value).toBe(second);
  });

  test("a mismatched index or suffix returns 409 without changing the pool", async () => {
    await store();
    expect((await request("DELETE", `?key=${KEY}&index=1&suffix=first`)).status).toBe(409);
    expect(await request("DELETE", `?key=${KEY}&index=0&suffix=other`)).toMatchObject({
      status: 409,
      body: { error: "The key list changed. Reload it and try again." },
    });
    expect((await getSwarmConfigs({ scope: "global", key: KEY }))[0]!.value).toBe(first);
  });

  test("removing the last member deletes the config row", async () => {
    await store();
    expect(await request("DELETE", `?key=${KEY}&index=0&suffix=first`)).toMatchObject({
      status: 200,
      body: { source: "none", keys: [] },
    });
    expect(await getSwarmConfigs({ scope: "global", key: KEY })).toEqual([]);
  });

  test("the response excludes a deleted key still injected into process.env", async () => {
    await store();
    await loadGlobalConfigsIntoEnv(true);
    expect(process.env[KEY]).toBe(first);
    expect(await request("DELETE", `?key=${KEY}&index=0&suffix=first`)).toMatchObject({
      status: 200,
      body: { source: "none", readOnly: false, keys: [] },
    });
    expect(await pool()).toMatchObject({ source: "none", keys: [] });
  });

  test("deleting the stored pool restores the deployment env source immediately", async () => {
    process.env[KEY] = second;
    await store();
    await loadGlobalConfigsIntoEnv(true);
    expect(await request("DELETE", `?key=${KEY}&index=0&suffix=first`)).toMatchObject({
      status: 200,
      body: { source: "env", readOnly: true, keys: [{ suffix: "secnd" }] },
    });
  });

  test.each([
    0, 1,
  ])("removing index %i keeps the surviving status at index zero", async (removed) => {
    await store(`${first},${second}`);
    await recordKeyValidation(KEY, [
      { keyIndex: 0, keySuffix: "first", ok: false, httpStatus: 401 },
      { keyIndex: 1, keySuffix: "secnd", ok: true },
    ]);
    const suffix = removed === 0 ? "first" : "secnd";
    expect((await request("DELETE", `?key=${KEY}&index=${removed}&suffix=${suffix}`)).status).toBe(
      200,
    );
    expect(await getAvailableKeyIndices(KEY, 1)).toMatchObject({
      availableIndices: removed === 0 ? [0] : [],
      rejectedIndices: removed === 0 ? [] : [0],
    });
  });
});
