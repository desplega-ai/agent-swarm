import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { closeDb, createAgent, createTaskExtended, createUser, initDb } from "../be/db";
import * as contractRuntime from "../extensions/contract-runtime";
import { executeReadOnlyQuery } from "../http/db-query";

// Unit tests for templates/extensions/sql-admin-only/hooks.ts. ctx.swarm.db_query is
// mocked with the real read-only db-query executor against a test DB, so the lookup SQL
// runs against the actual schema and the db-query table guard.

// `swarm-extension` is a bare import the extension loader shims to contract-runtime.
mock.module("swarm-extension", () => contractRuntime);

const TEST_DB_PATH = "./test-extensions-example-sql-admin-only.sqlite";

type Handler = (event: any, ctx: any) => Promise<any>;
let handler: Handler;
let mod: any;

let adminTaskId: string;
let requesterTaskId: string;
let noCreatorTaskId: string;
let requesterUserId: string;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);

  const agent = await createAgent({
    name: `sql-admin-only-${crypto.randomUUID()}`,
    isLead: false,
    status: "busy",
    capabilities: [],
  });
  // Both users also get the RBAC admin role from trg_users_default_role; the gate
  // must ignore it and read users.role.
  const admin = await createUser({ name: "Admin", role: "Admin" });
  const requester = await createUser({ name: "Requester", role: "engineer" });
  requesterUserId = requester.id;

  const base = { agentId: agent.id, source: "mcp" as const };
  adminTaskId = (await createTaskExtended("admin task", { ...base, requestedByUserId: admin.id }))
    .id;
  requesterTaskId = (
    await createTaskExtended("requester task", { ...base, requestedByUserId: requester.id })
  ).id;
  noCreatorTaskId = (await createTaskExtended("no creator task", base)).id;

  mod = await import("../../templates/extensions/sql-admin-only/hooks.ts");
  mod.default({
    on: (name: string, h: Handler) => {
      if (name === "pre.tool.call") handler = h;
    },
  });
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

type DbMode = "real" | "throws" | "fails" | "hangs";

const makeCtx = (mode: DbMode = "real") => {
  const queries: any[] = [];
  const warns: unknown[] = [];
  const swarm = {
    db_query: async (args: { sql: string; params?: unknown[] }) => {
      queries.push(args);
      if (mode === "throws") throw new Error("db down");
      if (mode === "fails") return { success: false };
      if (mode === "hangs") return await new Promise(() => {});
      const result = executeReadOnlyQuery(args.sql, args.params ?? []);
      return { success: true, data: { columns: result.columns, rows: result.rows } };
    },
  };
  return {
    ctx: {
      swarm,
      config: {},
      state: {},
      log: { debug() {}, info() {}, warn: (...a: unknown[]) => warns.push(a), error() {} },
      signal: new AbortController().signal,
    },
    queries,
    warns,
  };
};

const call = (tool: string, sourceTaskId?: string) => ({
  tool,
  args: { sql: "SELECT 1" },
  requestInfo: {
    sessionId: undefined,
    agentId: "agent-1",
    runtimeInstanceId: undefined,
    sourceTaskId,
    contextKey: undefined,
    callOrigin: "mcp",
  },
});

describe("sql-admin-only extension", () => {
  test("allows db-query when the call has no task", async () => {
    const { ctx, queries } = makeCtx();
    expect(await handler(call("db-query"), ctx)).toBeUndefined();
    expect(queries).toHaveLength(0);
  });

  test("allows db-query when the task has no creator", async () => {
    const { ctx, queries } = makeCtx();
    expect(await handler(call("db-query", noCreatorTaskId), ctx)).toBeUndefined();
    expect(queries).toHaveLength(1);
  });

  test("allows db-query for an admin creator", async () => {
    const { ctx } = makeCtx();
    expect(await handler(call("db-query", adminTaskId), ctx)).toBeUndefined();
  });

  test("passes every other tool untouched, even for a non-admin creator", async () => {
    const { ctx, queries } = makeCtx("throws");
    for (const tool of ["store-progress", "get-task-details", "memory-search"]) {
      expect(await handler(call(tool, requesterTaskId), ctx)).toBeUndefined();
    }
    expect(queries).toHaveLength(0);
  });

  test("blocks db-query for a non-admin creator", async () => {
    const { ctx, warns } = makeCtx();
    const result = await handler(call("db-query", requesterTaskId), ctx);
    expect(result).toEqual({
      action: "block",
      reason: expect.stringContaining("db-query is restricted to admin task creators"),
    });
    expect(result.reason).toContain(requesterUserId);
    expect(result.reason).toContain('"engineer"');
    expect(warns).toHaveLength(1);
  });

  test.each([
    ["the lookup throws", "throws", "db down"],
    ["the lookup returns success=false", "fails", "success=false"],
  ] as const)("blocks db-query when %s", async (_label, mode, detail) => {
    const { ctx } = makeCtx(mode);
    const result = await handler(call("db-query", requesterTaskId), ctx);
    expect(result.action).toBe("block");
    expect(result.reason).toContain("could not be verified");
    expect(result.reason).toContain(detail);
  });

  test("blocks db-query when the creator has no role", async () => {
    const agent = await createAgent({
      name: `sql-admin-only-${crypto.randomUUID()}`,
      isLead: false,
      status: "busy",
      capabilities: [],
    });
    const user = await createUser({ name: "No role" });
    const task = await createTaskExtended("no role task", {
      agentId: agent.id,
      source: "mcp",
      requestedByUserId: user.id,
    });
    const { ctx } = makeCtx();
    const result = await handler(call("db-query", task.id), ctx);
    expect(result.action).toBe("block");
    expect(result.reason).toContain("role is not set");
  });

  test("blocks db-query when the task row does not exist", async () => {
    const { ctx } = makeCtx();
    const result = await handler(call("db-query", crypto.randomUUID()), ctx);
    expect(result.action).toBe("block");
    expect(result.reason).toContain("not found");
  });

  test("blocks db-query when the lookup outlives its budget", async () => {
    const saved = process.env.EXTENSION_HANDLER_TIMEOUT_MS;
    process.env.EXTENSION_HANDLER_TIMEOUT_MS = "100";
    try {
      const { ctx } = makeCtx("hangs");
      const result = await handler(call("db-query", requesterTaskId), ctx);
      expect(result.action).toBe("block");
      expect(result.reason).toContain("timed out after 60ms");
    } finally {
      if (saved === undefined) delete process.env.EXTENSION_HANDLER_TIMEOUT_MS;
      else process.env.EXTENSION_HANDLER_TIMEOUT_MS = saved;
    }
  });
});
