/**
 * Credentials and identities for a user who gains an operator-granted role
 * (the built-in `auditor`, `session.read.all`).
 *
 * Every new user is a grant-all admin, so an admin must not end up holding a
 * credential that resolves to an auditor: not by racing the operator's grant
 * (check passes, grant commits, write lands), not by minting one before the
 * grant, and not through the Lead's `manage-user` tool. Each refusal has a
 * control that shows the same call passes when no operator-granted role is
 * added.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createConnectorCode, exchangeConnectorCode } from "../be/connector-codes";
import { closeDb, createAgent, createUser, getDbClient, getUserById, initDb } from "../be/db";
import { ensureRbacSeedsSynced } from "../be/rbac-roles";
import { getUserIdentities, resolveUserByToken } from "../be/users";
import { canReadAllSessions } from "../http/session-access";
import { handleUserRoles } from "../http/user-roles";
import { handleUsers } from "../http/users";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerManageUserTool } from "../tools/manage-user";
import type { HttpRequestAuth } from "../utils/request-auth-context";
import { setRequestAuth } from "../utils/request-auth-context";

const OPERATOR: HttpRequestAuth = { kind: "operator", fingerprint: "op:test" };
const LEAD_ID = "33333333-3333-4333-8333-333333333333";

function jsonReq(method: string, url: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = { "content-type": "application/json" };
  return req;
}

async function call(
  handler: "users" | "roles",
  method: string,
  url: string,
  opts: { auth?: HttpRequestAuth; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const req = jsonReq(method, url, opts.body);
  setRequestAuth(req as never, opts.auth ?? OPERATOR);
  let status = 200;
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk);
    },
  };
  const segments = getPathSegments(url);
  const query = parseQueryParams(url);
  const handled =
    handler === "users"
      ? await handleUsers(req as never, res as never, segments, query)
      : await handleUserRoles(req as never, res as never, segments, query);
  expect(handled).toBe(true);
  return { status, body: chunks.length > 0 ? JSON.parse(chunks.join("")) : null };
}

/** Operator-key role change over the wire. */
async function operatorSetRoles(userId: string, roles: string[]): Promise<void> {
  const res = await call("roles", "PUT", `/api/users/${userId}/roles`, { body: { roles } });
  expect(res.status).toBe(200);
}

/**
 * Holds the next top-level DB transaction before it starts. On the old
 * handlers the operator-granted check had already run by then.
 */
function holdNextTransaction() {
  const client = getDbClient();
  const original = client.transaction.bind(client);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markPaused!: () => void;
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  const spy = spyOn(client, "transaction").mockImplementationOnce((async (
    fn: (tx: never) => Promise<unknown>,
    opts?: never,
  ) => {
    markPaused();
    await gate;
    return original(fn, opts);
  }) as never);
  return { paused, release, restore: () => spy.mockRestore() };
}

async function liveTokenCount(userId: string): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM user_tokens WHERE userId = ? AND revokedAt IS NULL",
    [userId],
  );
  return row?.n ?? 0;
}

async function hasIdentity(userId: string, externalId: string): Promise<boolean> {
  return (await getUserIdentities(userId)).some((i) => i.externalId === externalId);
}

let seq = 0;
const unique = (prefix: string) => `${prefix}-${++seq}-${crypto.randomUUID().slice(0, 8)}`;

let adminAuth: HttpRequestAuth;
let server: McpServer;

beforeAll(async () => {
  initDb(":memory:");
  ensureRbacSeedsSynced({ quiet: true });
  const admin = await createUser({ name: "Default admin" });
  adminAuth = { kind: "user", userId: admin.id, user: admin as never };
  await createAgent({ id: LEAD_ID, name: "Lead", isLead: true, status: "idle" });
  server = new McpServer({ name: "test-operator-granted", version: "1.0.0" });
  registerManageUserTool(server);
});

afterAll(() => {
  closeDb();
});

/** One admin write that hands the caller a credential or identity on `target`. */
type EntryPoint = {
  name: string;
  run: (targetId: string) => Promise<{ status: number; body: any }>;
  /** Whether the write landed. */
  wrote: (targetId: string) => Promise<boolean>;
};

function entryPoints(): EntryPoint[] {
  const ext = new Map<string, string>();
  const idFor = (targetId: string) => {
    if (!ext.has(targetId)) ext.set(targetId, unique("U"));
    return ext.get(targetId) as string;
  };
  const sources = new Map<string, string>();
  return [
    {
      name: "POST /api/users/{id}/mcp-tokens",
      run: (t) =>
        call("users", "POST", `/api/users/${t}/mcp-tokens`, { auth: adminAuth, body: {} }),
      wrote: async (t) => (await liveTokenCount(t)) > 0,
    },
    {
      name: "POST /api/users/{id}/identities",
      run: (t) =>
        call("users", "POST", `/api/users/${t}/identities`, {
          auth: adminAuth,
          body: { kind: "slack", externalId: idFor(t) },
        }),
      wrote: (t) => hasIdentity(t, idFor(t)),
    },
    {
      name: "PATCH /api/users/{id} identities",
      run: (t) =>
        call("users", "PATCH", `/api/users/${t}`, {
          auth: adminAuth,
          body: { identities: [{ kind: "slack", externalId: idFor(t) }] },
        }),
      wrote: (t) => hasIdentity(t, idFor(t)),
    },
    {
      name: "PATCH /api/users/{id} emailAliases",
      run: (t) =>
        call("users", "PATCH", `/api/users/${t}`, {
          auth: adminAuth,
          body: { emailAliases: [`${idFor(t).toLowerCase()}@example.test`] },
        }),
      wrote: async (t) =>
        ((await getUserById(t))?.emailAliases ?? []).includes(
          `${idFor(t).toLowerCase()}@example.test`,
        ),
    },
    {
      name: "POST /api/users/unmapped/{kind}/{externalId}/resolve",
      run: (t) =>
        call("users", "POST", `/api/users/unmapped/slack/${idFor(t)}/resolve`, {
          auth: adminAuth,
          body: { userId: t },
        }),
      wrote: (t) => hasIdentity(t, idFor(t)),
    },
    {
      name: "POST /api/users/{id}/merge",
      run: async (t) => {
        const source = await createUser({ name: "Merge source", email: `${unique("s")}@x.test` });
        sources.set(t, source.id);
        return call("users", "POST", `/api/users/${t}/merge`, {
          auth: adminAuth,
          body: { sourceUserId: source.id },
        });
      },
      wrote: async (t) => (await getUserById(sources.get(t) as string)) == null,
    },
  ];
}

describe("an operator grant landing between the check and the write", () => {
  /**
   * Starts `entry` as the admin, holds its first transaction, lets the
   * operator set `roles` on the target, then lets the request finish.
   */
  async function raced(entry: EntryPoint, roles: string[]) {
    const target = await createUser({ name: unique("Target"), email: `${unique("t")}@x.test` });
    const hold = holdNextTransaction();
    try {
      const pending = entry.run(target.id);
      await Promise.race([hold.paused, pending]);
      hold.restore();
      await operatorSetRoles(target.id, roles);
      hold.release();
      return { target, res: await pending };
    } finally {
      hold.release();
      hold.restore();
    }
  }

  for (const entry of entryPoints()) {
    test(`${entry.name}: refused once auditor lands, and nothing is written`, async () => {
      const { target, res } = await raced(entry, ["admin", "auditor"]);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("operator key");
      expect(await entry.wrote(target.id)).toBe(false);
      expect(await liveTokenCount(target.id)).toBe(0);
    });
  }

  for (const entry of entryPoints()) {
    test(`${entry.name}: control, a grant without an operator-granted role lets it through`, async () => {
      const { target, res } = await raced(entry, ["requester"]);
      expect(res.status).toBe(200);
      expect(await entry.wrote(target.id)).toBe(true);
    });
  }
});

describe("credentials issued before the operator adds auditor", () => {
  test("an admin-minted MCP token stops resolving once auditor is added", async () => {
    const target = await createUser({ name: unique("Pre-planted") });
    const minted = await call("users", "POST", `/api/users/${target.id}/mcp-tokens`, {
      auth: adminAuth,
      body: {},
    });
    expect(minted.status).toBe(200);
    expect((await resolveUserByToken(minted.body.plaintext))?.id).toBe(target.id);

    await operatorSetRoles(target.id, ["admin", "auditor"]);

    expect(await canReadAllSessions(target.id)).toBe(true);
    expect(await resolveUserByToken(minted.body.plaintext)).toBeNull();
    expect(await liveTokenCount(target.id)).toBe(0);
  });

  test("control: a role change without an operator-granted role keeps the token", async () => {
    const target = await createUser({ name: unique("Plain") });
    const minted = await call("users", "POST", `/api/users/${target.id}/mcp-tokens`, {
      auth: adminAuth,
      body: {},
    });
    expect(minted.status).toBe(200);
    await operatorSetRoles(target.id, ["requester"]);
    expect((await resolveUserByToken(minted.body.plaintext))?.id).toBe(target.id);
  });

  test("an unspent connector code, even the operator's, is spent by the grant", async () => {
    const target = await createUser({ name: unique("Code holder") });
    const { code } = await createConnectorCode(target.id, "pre-grant", {
      kind: "operator",
      id: "op:test",
    });
    await operatorSetRoles(target.id, ["admin", "auditor"]);
    expect(await exchangeConnectorCode(code)).toBeNull();
    expect(await liveTokenCount(target.id)).toBe(0);
  });

  test("control: a connector code survives a role change without an operator-granted role", async () => {
    const target = await createUser({ name: unique("Plain code holder") });
    const { code } = await createConnectorCode(target.id, "pre-change", {
      kind: "operator",
      id: "op:test",
    });
    await operatorSetRoles(target.id, ["requester"]);
    expect((await exchangeConnectorCode(code))?.userId).toBe(target.id);
  });

  test("control: keeping auditor revokes nothing; only adding it does", async () => {
    const target = await createUser({ name: unique("Kept auditor") });
    await operatorSetRoles(target.id, ["admin", "auditor"]);
    const minted = await call("users", "POST", `/api/users/${target.id}/mcp-tokens`, { body: {} });
    expect(minted.status).toBe(200);
    await operatorSetRoles(target.id, ["admin", "auditor"]);
    expect((await resolveUserByToken(minted.body.plaintext))?.id).toBe(target.id);
  });
});

describe("manage-user (Lead MCP tool)", () => {
  async function callManageUser(args: Record<string, unknown>): Promise<CallToolResult> {
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: unknown, e: unknown) => Promise<CallToolResult> }
        >;
      }
    )._registeredTools;
    const tool = tools["manage-user"];
    if (!tool) throw new Error("manage-user not registered");
    return tool.handler(args, {
      sessionId: "test-session",
      requestInfo: { headers: { "x-agent-id": LEAD_ID } },
    });
  }

  const updates = (externalId: string, alias: string) => [
    { name: "identities", args: { identities: [{ kind: "slack", externalId }] } },
    { name: "email", args: { email: alias } },
    { name: "emailAliases", args: { emailAliases: [alias] } },
  ];

  for (const { name } of updates("x", "x")) {
    test(`update ${name} on an auditor is refused, and nothing is written`, async () => {
      const alias = `${unique("a")}@x.test`;
      const externalId = unique("U");
      const target = await createUser({
        name: unique("Lead target"),
        email: `${unique("e")}@x.test`,
      });
      await operatorSetRoles(target.id, ["admin", "auditor"]);
      const before = await getUserById(target.id);
      const args = updates(externalId, alias).find((u) => u.name === name)?.args;
      const result = await callManageUser({ action: "update", userId: target.id, ...args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("operator key");
      const after = await getUserById(target.id);
      expect(after?.email).toBe(before?.email);
      expect(after?.emailAliases ?? []).not.toContain(alias);
      expect(await hasIdentity(target.id, externalId)).toBe(false);
    });

    test(`control: update ${name} on a plain admin succeeds`, async () => {
      const alias = `${unique("a")}@x.test`;
      const externalId = unique("U");
      const target = await createUser({
        name: unique("Lead plain"),
        email: `${unique("e")}@x.test`,
      });
      const args = updates(externalId, alias).find((u) => u.name === name)?.args;
      const result = await callManageUser({ action: "update", userId: target.id, ...args });
      expect(result.isError).toBeFalsy();
      const after = await getUserById(target.id);
      if (name === "identities") expect(await hasIdentity(target.id, externalId)).toBe(true);
      if (name === "email") expect(after?.email).toBe(alias);
      if (name === "emailAliases") expect(after?.emailAliases ?? []).toContain(alias);
    });
  }

  test("control: a profile-only update on an auditor still succeeds", async () => {
    const target = await createUser({ name: unique("Lead notes") });
    await operatorSetRoles(target.id, ["admin", "auditor"]);
    const result = await callManageUser({ action: "update", userId: target.id, notes: "hi" });
    expect(result.isError).toBeFalsy();
    expect((await getUserById(target.id))?.notes).toBe("hi");
  });
});
