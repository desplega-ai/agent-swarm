/**
 * RBAC MCP-user admission wire e2e (DES-445 increment 5 phase 1).
 *
 * Spawns the real HTTP server, drives /mcp-user over Streamable HTTP with
 * aswt_ user tokens, and mutates only the scratch DB role rows between calls.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  api,
  countAuditRows,
  LEAD,
  makeScratchDir,
  readAuditRows,
  registerAgent,
  removeScratchDir,
  type SwarmServer,
  spawnSwarmServer,
  waitForAuditCount,
} from "./rbac-e2e-helpers";

setDefaultTimeout(120_000);

const REQUESTER_ROLE_ID = "rbac-role-requester";

type ToolCallResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

let dir: string;
let server: SwarmServer | undefined;

function mcpUserHeaders(token: string, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return headers;
}

async function mcpUserInit(base: string, token: string): Promise<string> {
  const res = await fetch(`${base}/mcp-user`, {
    method: "POST",
    headers: mcpUserHeaders(token),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "rbac-mcp-user-e2e", version: "1" },
        capabilities: {},
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id");
  const text = await res.text();
  if (!res.ok || !sessionId) {
    throw new Error(`MCP-user initialize failed: HTTP ${res.status}: ${text}`);
  }

  const notify = await fetch(`${base}/mcp-user`, {
    method: "POST",
    headers: mcpUserHeaders(token, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await notify.text();
  return sessionId;
}

async function mcpUserCall(
  base: string,
  token: string,
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const res = await fetch(`${base}/mcp-user`, {
    method: "POST",
    headers: mcpUserHeaders(token, sessionId),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`tools/call ${tool} failed: HTTP ${res.status}: ${text}`);

  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const msg = JSON.parse(line.slice("data: ".length)) as {
      id?: number;
      error?: unknown;
      result?: ToolCallResult;
    };
    if (msg.id !== 7) continue;
    if (msg.error) throw new Error(`tools/call ${tool} error: ${JSON.stringify(msg.error)}`);
    if (!msg.result) throw new Error(`tools/call ${tool}: missing result`);
    return msg.result;
  }
  throw new Error(`tools/call ${tool}: no data frame with id 7 in response: ${text}`);
}

function rewriteUserRoles(dbPath: string, userId: string, roleIds: string[]): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.transaction(() => {
      db.prepare(
        "DELETE FROM principal_roles WHERE principalType = 'user' AND principalId = ?",
      ).run(userId);
      const insert = db.prepare(
        `INSERT INTO principal_roles (principalType, principalId, roleId)
         VALUES ('user', ?, ?)`,
      );
      for (const roleId of roleIds) {
        insert.run(userId, roleId);
      }
    })();
  } finally {
    db.close();
  }
}

async function createUserToken(
  base: string,
  name: string,
): Promise<{ userId: string; token: string }> {
  const email = `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}@example.com`;
  const user = await api(base, "POST", "/api/users", {
    body: { name, email },
  });
  expect(user.status).toBe(200);
  const userId = user.body.user.id as string;

  const minted = await api(base, "POST", `/api/users/${userId}/mcp-tokens`, { body: {} });
  expect(minted.status).toBe(200);
  const token = minted.body.plaintext as string;
  expect(token).toStartWith("aswt_");
  return { userId, token };
}

async function createPendingTask(base: string, token: string): Promise<string> {
  const res = await api(base, "POST", "/api/tasks", {
    bearer: token,
    body: { task: `pending task ${crypto.randomUUID()}` },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function taskIdFrom(result: ToolCallResult): string {
  expect(result.isError).not.toBe(true);
  const task = result.structuredContent?.task as { id?: unknown } | undefined;
  expect(typeof task?.id).toBe("string");
  return task.id as string;
}

function expectToolSuccess(result: ToolCallResult): void {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent?.success).toBe(true);
}

function expectReadableToolResult(result: ToolCallResult): void {
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result.content ?? [])).not.toContain("Forbidden:");
}

function expectSoftForbidden(result: ToolCallResult, verb: string): void {
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content ?? [])).toContain(
    `Forbidden: admission: missing permission '${verb}'`,
  );
}

async function createUnassignedViaMcp(
  base: string,
  token: string,
  sessionId: string,
): Promise<string> {
  const created = await mcpUserCall(base, token, sessionId, "send-task", {
    task: `unassigned task ${crypto.randomUUID()}`,
  });
  expectToolSuccess(created);
  return taskIdFrom(created);
}

async function exerciseAllowedUserTools(
  base: string,
  token: string,
  sessionId: string,
  pendingTaskId: string,
  unassignedTaskId: string,
): Promise<void> {
  const created = await mcpUserCall(base, token, sessionId, "send-task", {
    task: `allowed send-task ${crypto.randomUUID()}`,
  });
  expectToolSuccess(created);

  const list = await mcpUserCall(base, token, sessionId, "get-tasks", { limit: 10 });
  expectReadableToolResult(list);
  expect(Array.isArray(list.structuredContent?.tasks)).toBe(true);

  const details = await mcpUserCall(base, token, sessionId, "get-task-details", {
    taskId: pendingTaskId,
  });
  expectToolSuccess(details);

  const cancelled = await mcpUserCall(base, token, sessionId, "cancel-task", {
    taskId: pendingTaskId,
    reason: "rbac mcp-user e2e",
  });
  expectToolSuccess(cancelled);

  const moved = await mcpUserCall(base, token, sessionId, "task-action", {
    action: "to_backlog",
    taskId: unassignedTaskId,
  });
  expectToolSuccess(moved);
}

describe("RBAC admission over /mcp-user", () => {
  afterAll(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
    if (dir) await removeScratchDir(dir);
  });

  test("flag-on admin bypass, requester allow-list, empty grant soft-deny, and flag-off no-op", async () => {
    dir = await makeScratchDir();
    const enabledDbPath = join(dir, "mcp-admission-on.sqlite");

    server = await spawnSwarmServer({
      dbPath: enabledDbPath,
      logPath: join(dir, "server-on.log"),
      env: { RBAC_ENABLED: "true" },
    });
    await registerAgent(server.base, LEAD, "mcp-admission-lead", true);

    const admin = await createUserToken(server.base, "MCP Admin");
    const adminSid = await mcpUserInit(server.base, admin.token);
    const adminPendingTaskId = await createPendingTask(server.base, admin.token);
    const adminUnassignedTaskId = await createUnassignedViaMcp(server.base, admin.token, adminSid);

    await exerciseAllowedUserTools(
      server.base,
      admin.token,
      adminSid,
      adminPendingTaskId,
      adminUnassignedTaskId,
    );
    expect(countAuditRows(enabledDbPath)).toBe(0);

    const requester = await createUserToken(server.base, "MCP Requester");
    const requesterSid = await mcpUserInit(server.base, requester.token);
    const requesterPendingTaskId = await createPendingTask(server.base, requester.token);
    const requesterUnassignedTaskId = await createUnassignedViaMcp(
      server.base,
      requester.token,
      requesterSid,
    );
    rewriteUserRoles(enabledDbPath, requester.userId, [REQUESTER_ROLE_ID]);

    await exerciseAllowedUserTools(
      server.base,
      requester.token,
      requesterSid,
      requesterPendingTaskId,
      requesterUnassignedTaskId,
    );

    const empty = await createUserToken(server.base, "MCP Empty Grant");
    const emptySid = await mcpUserInit(server.base, empty.token);
    const emptyPendingTaskId = await createPendingTask(server.base, empty.token);
    const emptyUnassignedTaskId = await createUnassignedViaMcp(server.base, empty.token, emptySid);
    rewriteUserRoles(enabledDbPath, empty.userId, []);

    expectSoftForbidden(
      await mcpUserCall(server.base, empty.token, emptySid, "send-task", {
        task: "empty grant should not create",
      }),
      "task.create.own",
    );
    expectSoftForbidden(
      await mcpUserCall(server.base, empty.token, emptySid, "cancel-task", {
        taskId: emptyPendingTaskId,
      }),
      "task.cancel.own",
    );
    expectSoftForbidden(
      await mcpUserCall(server.base, empty.token, emptySid, "task-action", {
        action: "to_backlog",
        taskId: emptyUnassignedTaskId,
      }),
      "task.action.own",
    );
    expectReadableToolResult(
      await mcpUserCall(server.base, empty.token, emptySid, "get-tasks", { limit: 10 }),
    );
    expectToolSuccess(
      await mcpUserCall(server.base, empty.token, emptySid, "get-task-details", {
        taskId: emptyPendingTaskId,
      }),
    );

    expect(await waitForAuditCount(enabledDbPath, 10)).toBeGreaterThanOrEqual(10);
    const mcpRows = readAuditRows(enabledDbPath).filter((row) => row.source === "mcp");
    expect(
      mcpRows.some(
        (row) =>
          row.principalId === requester.userId &&
          row.resourceType === "mcp-tool" &&
          row.resourceId === "send-task" &&
          row.verb === "task.create.own" &&
          row.decision === "allow",
      ),
    ).toBe(true);
    expect(
      mcpRows
        .filter((row) => row.principalId === empty.userId && row.decision === "deny")
        .map((row) => row.verb),
    ).toEqual(["task.create.own", "task.cancel.own", "task.action.own"]);

    await server.stop();
    server = undefined;

    const disabledDbPath = join(dir, "mcp-admission-off.sqlite");
    server = await spawnSwarmServer({
      dbPath: disabledDbPath,
      logPath: join(dir, "server-off.log"),
    });
    await registerAgent(server.base, LEAD, "mcp-admission-lead-off", true);

    const flagOff = await createUserToken(server.base, "MCP Flag Off");
    const flagOffSid = await mcpUserInit(server.base, flagOff.token);
    rewriteUserRoles(disabledDbPath, flagOff.userId, []);
    const flagOffPendingTaskId = await createPendingTask(server.base, flagOff.token);
    const flagOffUnassignedTaskId = await createUnassignedViaMcp(
      server.base,
      flagOff.token,
      flagOffSid,
    );

    await exerciseAllowedUserTools(
      server.base,
      flagOff.token,
      flagOffSid,
      flagOffPendingTaskId,
      flagOffUnassignedTaskId,
    );
    expect(countAuditRows(disabledDbPath)).toBe(0);
  });
});
