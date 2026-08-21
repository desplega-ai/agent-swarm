import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { applyAppDefinitionPatch, parseAppDefinition } from "../apps/definition";
import { getAppUserConfigValues, mergeUserConfigValues } from "../apps/user-config";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  initDb,
} from "../be/db";
import { type IdentityActor, mintToken } from "../be/users";
import { handleApps } from "../http/apps";
import { resolveHttpRequestAuth } from "../http/auth";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { clearAuditSink, LEGACY_POLICY, type LegacyRule, setAuditSink } from "../rbac";
import type { RbacCheck } from "../rbac/types";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = `/private/tmp/test-apps-user-config-${process.pid}.sqlite`;
const API_KEY = "apps-user-config-test-key";
const AGENT_ID = crypto.randomUUID();
const OPERATOR_ACTOR: IdentityActor = { kind: "operator", id: "apps-user-config-test" };
const mutableLegacyPolicy = LEGACY_POLICY as unknown as Record<"app.use", LegacyRule>;

const baseDefinition = {
  models: { note: { columns: { title: { kind: "string" } } } },
  pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
  defaultPage: "main",
};
const userConfig = {
  density: { kind: "enum", enum: ["compact", "comfortable"], default: "comfortable" },
  title: { kind: "string", default: "Inbox" },
  visible: { kind: "boolean", default: true },
  pageSize: { kind: "number", default: 20 },
};

type Principal = "operator" | "user1" | "user2" | "agent";
let server: Server;
let base = "";
let appId = "";
let user1Id = "";
let user2Id = "";
let user1Token = "";
let user2Token = "";

function definition(config: Record<string, unknown> | null = userConfig) {
  return config === null
    ? structuredClone(baseDefinition)
    : { ...baseDefinition, userConfig: config };
}

function headers(principal: Principal): HeadersInit {
  if (principal === "operator") return { Authorization: `Bearer ${API_KEY}` };
  if (principal === "agent") {
    return { Authorization: `Bearer ${API_KEY}`, "X-Agent-ID": AGENT_ID };
  }
  return { Authorization: `Bearer ${principal === "user1" ? user1Token : user2Token}` };
}

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    setRequestAuth(req, await resolveHttpRequestAuth(req, API_KEY));
    res.setHeader("Content-Type", "application/json");
    if (
      await handleApps(
        req,
        res,
        getPathSegments(req.url || ""),
        parseQueryParams(req.url || ""),
        req.headers["x-agent-id"] as string | undefined,
      )
    )
      return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
}

async function request<T>(
  path: string,
  principal: Principal = "operator",
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...headers(principal), ...init.headers },
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function createFixture(config: Record<string, unknown> | null = userConfig): Promise<string> {
  const response = await request<{ app: { id: string } }>("/api/apps", "operator", {
    method: "POST",
    body: JSON.stringify({ name: "User config fixture", definition: definition(config) }),
  });
  expect(response.status).toBe(201);
  return response.body.app.id;
}

async function put(values: Record<string, unknown>, principal: Principal = "operator") {
  return request<{ values: Record<string, unknown> }>(`/api/apps/${appId}/user-config`, principal, {
    method: "PUT",
    body: JSON.stringify({ values }),
  });
}

async function get(principal: Principal = "operator") {
  return request<{ values: Record<string, unknown>; schema: Record<string, unknown> }>(
    `/api/apps/${appId}/user-config`,
    principal,
  );
}

async function expectDefinitionIssue(candidate: unknown, message: string): Promise<void> {
  const parsed = await parseAppDefinition(candidate);
  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(parsed.issues.some((entry) => entry.message.includes(message))).toBe(true);
  }
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
  initDb(TEST_DB_PATH);
  await createAgent({
    id: AGENT_ID,
    name: "apps-user-config-agent",
    isLead: false,
    status: "idle",
  });
  const user1 = await createUser({ name: "User config one" });
  const user2 = await createUser({ name: "User config two" });
  user1Id = user1.id;
  user2Id = user2.id;
  user1Token = (await mintToken(user1.id, "apps-user-config-one", OPERATOR_ACTOR)).plaintext;
  user2Token = (await mintToken(user2.id, "apps-user-config-two", OPERATOR_ACTOR)).plaintext;
  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  clearAuditSink();
  await getDbClient().run("DELETE FROM apps");
  appId = await createFixture();
  clearAuditSink();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
});

describe("userConfig definition", () => {
  test("validates defaults, enum membership, required rejection, field cap, and atomic patches", async () => {
    expect((await parseAppDefinition(definition())).success).toBe(true);
    for (const [field, patch] of [
      ["badEnum", { kind: "enum", enum: ["a"], default: "b" }],
      ["badNumber", { kind: "number", default: "2" }],
      ["required", { kind: "string", required: true }],
    ] as const) {
      const parsed = await parseAppDefinition({ ...definition(), userConfig: { [field]: patch } });
      expect(parsed.success).toBe(false);
    }
    const tooMany = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`field${i}`, { kind: "string" }]),
    );
    expect((await parseAppDefinition({ ...definition(), userConfig: tooMany })).success).toBe(
      false,
    );
    await expectDefinitionIssue(
      { ...definition(), userConfig: { mode: { kind: "enum", enum: [""] } } },
      "enum values must be non-empty",
    );
    await expectDefinitionIssue(
      {
        ...definition(),
        models: { note: { columns: { status: { kind: "enum", enum: [""] } } } },
      },
      "enum values must be non-empty",
    );

    const patch = await parseAppDefinition(definition());
    expect(patch.success).toBe(true);
    if (!patch.success) return;
    const atomic = applyAppDefinitionPatch(patch.definition, {
      userConfig: { density: { kind: "string" } },
    });
    expect(atomic.success).toBe(true);
    if (atomic.success)
      expect((atomic.definition as { userConfig?: unknown }).userConfig).toEqual({
        density: { kind: "string" },
        title: { kind: "string", default: "Inbox" },
        visible: { kind: "boolean", default: true },
        pageSize: { kind: "number", default: 20 },
      });
  });

  test("accepts exact declared page bindings and rejects every reusable or invalid /user path", async () => {
    const pageBinding = {
      ...definition(),
      pages: {
        main: {
          root: "density",
          elements: {
            density: { type: "Text", props: { content: { $state: "/user/density" } } },
          },
        },
      },
    };
    const parsed = await parseAppDefinition(pageBinding);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const roundTripped = await parseAppDefinition(JSON.parse(JSON.stringify(parsed.definition)));
    expect(roundTripped.success).toBe(true);
    if (roundTripped.success) {
      expect(
        (
          roundTripped.definition.pages.main?.elements.density as {
            props: { content: { $state: string } };
          }
        ).props.content.$state,
      ).toBe("/user/density");
    }

    const undeclared = structuredClone(pageBinding);
    undeclared.pages.main.elements.density.props.content.$state = "/user/missing";
    await expectDefinitionIssue(
      undeclared,
      'unknown userConfig field "missing"; declared fields: density, pageSize, title, visible',
    );

    const deep = structuredClone(pageBinding);
    deep.pages.main.elements.density.props.content.$state = "/user/density/value";
    await expectDefinitionIssue(
      deep,
      "must target exactly /user/<field>; nested paths are not supported",
    );

    for (const mode of ["pure", "bound"] as const) {
      await expectDefinitionIssue(
        {
          ...definition(),
          elements: {
            preferences: {
              mode,
              root: "density",
              elements: {
                density: { type: "Text", props: { content: { $state: "/user/density" } } },
              },
            },
          },
        },
        `${mode} elements cannot read /user state; read userConfig via a prop or bind it at page level`,
      );
    }
  });
});

describe("userConfig HTTP storage", () => {
  test("validates PUT values and enforces the 16 KB serialized cap", async () => {
    expect((await put({ density: "spacious" })).status).toBe(400);
    expect((await put({ pageSize: "20" })).status).toBe(400);
    expect((await put({ absent: true })).status).toBe(400);
    // Prototype-named fields are ordinary unknown fields (400) — the reserved-
    // key map lookup must not resolve inherited Object.prototype members
    // (`.test()` on a function threw, turning bad input into a 500; a null
    // value even skipped validation and was stored).
    expect((await put({ toString: "x" })).status).toBe(400);
    expect((await put({ hasOwnProperty: null })).status).toBe(400);
    expect((await put({ title: "x".repeat(16 * 1024) })).status).toBe(413);
    expect(
      (
        await request(`/api/apps/${appId}/user-config`, "operator", {
          method: "PUT",
          body: JSON.stringify({ values: {}, padding: "x".repeat(64 * 1024) }),
        })
      ).status,
    ).toBe(413);
    const saved = await put({ density: "compact", pageSize: 10 });
    expect(saved.status).toBe(200);
    expect(saved.body.values).toEqual({
      density: "compact",
      title: "Inbox",
      visible: true,
      pageSize: 10,
    });
  });

  test("isolates user and operator scopes and upserts each unique scope", async () => {
    expect((await put({ title: "one" }, "user1")).status).toBe(200);
    expect((await get("user2")).body.values).toMatchObject({ title: "Inbox" });
    expect((await put({ title: "two" }, "user2")).status).toBe(200);
    expect((await put({ title: "operator" }, "operator")).status).toBe(200);
    expect((await get("user1")).body.values).toMatchObject({ title: "one" });
    expect((await get("user2")).body.values).toMatchObject({ title: "two" });
    expect((await get("operator")).body.values).toMatchObject({ title: "operator" });
    expect(
      await getDbClient().get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM app_user_config WHERE appId = ?",
        [appId],
      ),
    ).toEqual({ count: 3 });
    const scopes = (
      await getDbClient().query<{ scope: string }>(
        "SELECT scope FROM app_user_config WHERE appId = ?",
        [appId],
      )
    )
      .map((row) => row.scope)
      .sort();
    expect(scopes).toEqual(["operator", `user:${user1Id}`, `user:${user2Id}`].sort());
    await put({ title: "one again" }, "user1");
    expect(
      await getDbClient().get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM app_user_config WHERE appId = ?",
        [appId],
      ),
    ).toEqual({ count: 3 });
  });

  test("agents get defaults but cannot persist and no-schema GET is empty", async () => {
    expect((await put({ title: "operator" }, "operator")).status).toBe(200);
    expect((await get("agent")).body.values).toMatchObject({
      title: "Inbox",
      density: "comfortable",
    });
    const denied = await put({ title: "agent" }, "agent");
    expect(denied.status).toBe(403);
    expect((denied.body as unknown as { error: string }).error).toBe(
      "userConfig is per-user; agents have no user scope",
    );
    expect((await get("operator")).body.values.title).toBe("operator");
    await getDbClient().run("DELETE FROM apps");
    appId = await createFixture(null);
    expect((await get()).body).toEqual({ values: {}, schema: {} });
    expect((await put({})).status).toBe(400);
  });

  test("agents acting on owned user-requested tasks use the requester scope", async () => {
    const requester = await createUser({ name: "Delegated userConfig requester" });
    const task = await createTaskExtended("Edit requester app preferences", {
      agentId: AGENT_ID,
      requestedByUserId: requester.id,
    });
    const delegatedHeaders = { "X-Source-Task-Id": task.id };
    const saved = await request<{ values: Record<string, unknown> }>(
      `/api/apps/${appId}/user-config`,
      "agent",
      {
        method: "PUT",
        headers: delegatedHeaders,
        body: JSON.stringify({ values: { title: "delegated" } }),
      },
    );
    expect(saved.status).toBe(200);
    const read = await request<{ values: Record<string, unknown> }>(
      `/api/apps/${appId}/user-config`,
      "agent",
      { headers: delegatedHeaders },
    );
    expect(read.body.values.title).toBe("delegated");
    expect(
      await getDbClient().get<{ scope: string; storedValues: string }>(
        'SELECT scope, "values" AS storedValues FROM app_user_config WHERE appId = ? AND scope = ?',
        [appId, `user:${requester.id}`],
      ),
    ).toEqual({ scope: `user:${requester.id}`, storedValues: '{"title":"delegated"}' });
  });

  test("tolerantly drops removed fields and uses defaults for kind changes", async () => {
    await put({ title: "saved", pageSize: 30 });
    const changed = {
      ...baseDefinition,
      userConfig: { pageSize: { kind: "string", default: "25" } },
    };
    expect(
      (
        await request(`/api/apps/${appId}`, "operator", {
          method: "PUT",
          body: JSON.stringify({ definition: changed }),
        })
      ).status,
    ).toBe(200);
    expect((await get()).body.values).toEqual({ pageSize: "25" });
  });

  test("rollback restores versioned schema without altering the stored values row", async () => {
    await put({ title: "persistent" });
    const before = await getDbClient().get(
      "SELECT \"values\" AS storedValues FROM app_user_config WHERE appId = ? AND scope = 'operator'",
      [appId],
    );
    expect(
      (
        await request(`/api/apps/${appId}`, "operator", {
          method: "PUT",
          body: JSON.stringify({ definition: definition(null) }),
        })
      ).status,
    ).toBe(200);
    const rollback = await request(`/api/apps/${appId}/rollback`, "operator", {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(rollback.status).toBe(200);
    const after = await getDbClient().get(
      "SELECT \"values\" AS storedValues FROM app_user_config WHERE appId = ? AND scope = 'operator'",
      [appId],
    );
    expect(after).toEqual(before);
    expect((await get()).body.values).toMatchObject({ title: "persistent" });
  });

  test("reports userConfig changes and snapshots the schema", async () => {
    const next = { ...definition(), userConfig: { title: { kind: "string", default: "next" } } };
    const response = await request<{ migration: { userConfigChanged: string[] } }>(
      `/api/apps/${appId}`,
      "operator",
      {
        method: "PUT",
        body: JSON.stringify({ definition: next }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.migration.userConfigChanged).toEqual([
      "density",
      "pageSize",
      "title",
      "visible",
    ]);
    const versions = await request<{
      versions: Array<{ snapshot: { definition: { userConfig: unknown } } }>;
    }>(`/api/apps/${appId}/versions`);
    expect(versions.body.versions[0]?.snapshot.definition.userConfig).toEqual(userConfig);
  });

  test("returns needs-repair for a broken definition", async () => {
    await getDbClient().run("UPDATE apps SET definition = ? WHERE id = ?", ["{", appId]);
    expect((await get()).status).toBe(409);
    expect((await put({ title: "nope" })).status).toBe(409);
  });

  test("routes both reach scoped app.use authorization", async () => {
    const checks: RbacCheck[] = [];
    const original = mutableLegacyPolicy["app.use"];
    mutableLegacyPolicy["app.use"] = { ...original, evaluate: () => false };
    setAuditSink((check) => checks.push(check));
    try {
      expect((await get()).status).toBe(403);
      expect((await put({ title: "denied" })).status).toBe(403);
      expect(checks).toEqual([
        {
          principal: { kind: "operator" },
          verb: "app.use",
          resource: { kind: "app", appId },
          source: "http",
        },
        {
          principal: { kind: "operator" },
          verb: "app.use",
          resource: { kind: "app", appId },
          source: "http",
        },
      ]);
    } finally {
      mutableLegacyPolicy["app.use"] = original;
    }
  });
});

describe("mergeUserConfigValues", () => {
  test("drops unknown values, restores defaults for bad values, and yields nullable reads", () => {
    expect(
      mergeUserConfigValues(
        {
          title: { kind: "string", default: "default" },
          flag: { kind: "boolean" },
          mode: { kind: "enum", enum: ["a", "b"], default: "a" },
        },
        { title: 7, removed: "gone", flag: "true", mode: "no" },
      ),
    ).toEqual({ title: "default", flag: null, mode: "a" });
  });

  test("treats an explicit stored null as invalid and restores the default", () => {
    expect(
      mergeUserConfigValues({ title: { kind: "string", default: "default" } }, { title: null }),
    ).toEqual({ title: "default" });
  });

  test("treats a non-object stored blob as empty values", () => {
    expect(
      mergeUserConfigValues(
        { title: { kind: "string", default: "default" }, flag: { kind: "boolean" } },
        "legacy blob",
      ),
    ).toEqual({ title: "default", flag: null });
  });

  test("treats malformed stored JSON as empty before the tolerant merge", async () => {
    await put({ title: "stored" });
    await getDbClient().run(
      'UPDATE app_user_config SET "values" = ? WHERE appId = ? AND scope = ?',
      ["{", appId, "operator"],
    );
    expect(
      mergeUserConfigValues(userConfig, await getAppUserConfigValues(appId, "operator")),
    ).toEqual({
      density: "comfortable",
      title: "Inbox",
      visible: true,
      pageSize: 20,
    });
  });

  test("preserves a valid reserved $theme and drops an invalid one", () => {
    expect(
      mergeUserConfigValues(
        { title: { kind: "string", default: "default" } },
        { title: "kept", $theme: "cobalt" },
      ),
    ).toEqual({ title: "kept", $theme: "cobalt" });
    expect(mergeUserConfigValues({}, { $theme: "Not A Slug", $unknown: "dropped" })).toEqual({});
  });
});

describe("app theme", () => {
  test("definition accepts a slug theme, rejects malformed ones, and suggests the key", async () => {
    expect((await parseAppDefinition({ ...definition(), theme: "cobalt" })).success).toBe(true);
    await expectDefinitionIssue(
      { ...definition(), theme: "Not A Slug" },
      "must be a lowercase slug",
    );
    await expectDefinitionIssue({ ...definition(), styling: "cobalt" }, 'did you mean "theme"');
  });

  test("PUT accepts the reserved $theme alongside declared fields and round-trips it", async () => {
    const saved = await put({ $theme: "ember", density: "compact" });
    expect(saved.status).toBe(200);
    expect(saved.body.values).toMatchObject({ $theme: "ember", density: "compact" });
    expect((await get()).body.values).toMatchObject({ $theme: "ember" });
    expect((await put({ $theme: "Not A Slug" })).status).toBe(400);
  });

  test("no-schema apps accept reserved-only writes but keep the historical 400 otherwise", async () => {
    await getDbClient().run("DELETE FROM apps");
    appId = await createFixture(null);
    expect((await put({})).status).toBe(400);
    expect((await put({ title: "author key" })).status).toBe(400);
    expect((await put({ $theme: "ember", title: "author key" })).status).toBe(400);
    const saved = await put({ $theme: "ember" });
    expect(saved.status).toBe(200);
    expect(saved.body.values).toEqual({ $theme: "ember" });
    expect((await get()).body.values).toEqual({ $theme: "ember" });
    // Explicit clear: null is accepted and the merged read drops the key.
    const cleared = await put({ $theme: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.values).toEqual({});
    expect((await get()).body.values).toEqual({});
  });
});
