import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { __resetKillSwitchWarnedForTests, canClaim } from "../be/budget-admission";
import {
  closeDb,
  createAgent,
  createSessionCost,
  createTaskExtended,
  createUser,
  getDailySpendForUser,
  getDb,
  getTaskById,
  initDb,
  upsertBudget,
} from "../be/db";
import { type IdentityActor, mintToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleMcpUser } from "../http/mcp-user";
import { handlePoll } from "../http/poll";

const TEST_DB_PATH = "./test-budget-user-scope.sqlite";
const NOW = new Date("2026-04-28T15:30:00.000Z");
const TODAY = "2026-04-28";
const API_KEY = "test-budget-user-scope-key";
const ACTOR: IdentityActor = { kind: "operator", id: "phase6-test" };

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM session_costs").run();
  db.prepare("DELETE FROM budget_refusal_notifications").run();
  db.prepare("DELETE FROM agent_tasks").run();
  db.prepare("DELETE FROM budgets").run();
  db.prepare("DELETE FROM user_identity_events").run();
  db.prepare("DELETE FROM user_tokens").run();
  db.prepare("DELETE FROM users").run();
  db.prepare("DELETE FROM agents").run();
  createAgent({
    id: "agent-1",
    name: "agent-1",
    isLead: false,
    status: "idle",
  });
});

afterEach(() => {
  delete process.env.BUDGET_ADMISSION_DISABLED;
  __resetKillSwitchWarnedForTests();
});

function insertUserTaskSpend(
  userId: string,
  totalCostUsd: number,
  createdAt = `${TODAY}T12:00:00.000Z`,
) {
  const task = createTaskExtended(`task for ${userId}`, {
    requestedByUserId: userId,
    status: "unassigned",
  });
  const cost = createSessionCost({
    sessionId: `sess-${crypto.randomUUID()}`,
    taskId: task.id,
    agentId: "agent-1",
    totalCostUsd,
    durationMs: 1000,
    numTurns: 1,
    model: "test-model",
  });
  getDb().prepare("UPDATE session_costs SET createdAt = ? WHERE id = ?").run(createdAt, cost.id);
  return { task, cost };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function createMcpUserTestServer(): Server {
  const transportsUser: Record<string, StreamableHTTPServerTransport> = {};
  const sessionUsers: Record<string, string> = {};

  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    if (await handleMcpUser(req, res, transportsUser, sessionUsers)) return;
    res.writeHead(404);
    res.end("Not Found");
  });
}

function parseMcpPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const data = trimmed
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    return JSON.parse(data);
  }
  return JSON.parse(trimmed);
}

async function mcpPost(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ response: Response; payload: unknown }> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(`${baseUrl}/mcp-user`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, payload: text ? parseMcpPayload(text) : null };
}

async function initializeMcpUser(baseUrl: string, token: string): Promise<string> {
  const { response } = await mcpPost(baseUrl, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "budget-user-scope-test", version: "1" },
      capabilities: {},
    },
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("missing mcp-session-id");

  const initialized = await mcpPost(
    baseUrl,
    token,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  expect([200, 202]).toContain(initialized.response.status);
  return sessionId;
}

async function callPoll(agentId: string): Promise<{
  status: number;
  body: { trigger: { type: string; [key: string]: unknown } | null } | { error: string };
}> {
  let status = 200;
  let bodyStr = "";
  const headers: Record<string, string> = {};

  const req = {
    method: "GET",
    url: "/api/poll",
    headers: { "x-agent-id": agentId },
  } as unknown as Parameters<typeof handlePoll>[0];

  const res = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, h?: Record<string, string>) {
      status = code;
      if (h) {
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
      }
    },
    end(body?: string) {
      bodyStr = body ?? "";
    },
  } as unknown as Parameters<typeof handlePoll>[1];

  const handled = await handlePoll(req, res, ["api", "poll"], new URLSearchParams(), agentId);
  if (!handled) throw new Error("handlePoll did not handle the request");
  return { status, body: bodyStr ? JSON.parse(bodyStr) : { trigger: null } };
}

describe("user budget scope", () => {
  test("getDailySpendForUser sums only costs for that user's tasks on that UTC day", () => {
    const userA = createUser({ name: "User A" });
    const userB = createUser({ name: "User B" });

    insertUserTaskSpend(userA.id, 1.25);
    insertUserTaskSpend(userA.id, 2.75);
    insertUserTaskSpend(userA.id, 99, "2026-04-27T23:59:59.999Z");
    insertUserTaskSpend(userB.id, 10);

    const unownedTask = createTaskExtended("unowned", { status: "unassigned" });
    createSessionCost({
      sessionId: `sess-${crypto.randomUUID()}`,
      taskId: unownedTask.id,
      agentId: "agent-1",
      totalCostUsd: 100,
      durationMs: 1000,
      numTurns: 1,
      model: "test-model",
    });

    expect(getDailySpendForUser(userA.id, TODAY)).toBe(4);
    expect(getDailySpendForUser(userB.id, TODAY)).toBe(10);
  });

  test("canClaim refuses with cause='user' when requested user's spend is at the cap", () => {
    const user = createUser({ name: "Budgeted User" });
    upsertBudget("user", user.id, 2);
    insertUserTaskSpend(user.id, 2);

    const result = canClaim("agent-1", NOW, user.id);

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.cause).toBe("user");
    expect(result.userSpend).toBe(2);
    expect(result.userBudget).toBe(2);
    expect(result.agentSpend).toBeUndefined();
    expect(result.globalSpend).toBeUndefined();
  });

  test("canClaim allows user-scoped tasks when user spend is below the cap", () => {
    const user = createUser({ name: "Budgeted User" });
    upsertBudget("user", user.id, 2);
    insertUserTaskSpend(user.id, 1.99);

    const result = canClaim("agent-1", NOW, user.id);

    expect(result.allowed).toBe(true);
  });

  test("agent and global gates keep their existing precedence", () => {
    const user = createUser({ name: "Budgeted User" });
    upsertBudget("global", "", 1);
    upsertBudget("agent", "agent-1", 1);
    upsertBudget("user", user.id, 1);
    insertUserTaskSpend(user.id, 1);

    const globalResult = canClaim("agent-1", NOW, user.id);
    expect(globalResult.allowed).toBe(false);
    if (globalResult.allowed) throw new Error("unreachable");
    expect(globalResult.cause).toBe("global");

    getDb().prepare("DELETE FROM budgets WHERE scope = 'global'").run();
    const agentResult = canClaim("agent-1", NOW, user.id);
    expect(agentResult.allowed).toBe(false);
    if (agentResult.allowed) throw new Error("unreachable");
    expect(agentResult.cause).toBe("agent");
  });

  test("user gate is skipped when the candidate task has no requested user", () => {
    const user = createUser({ name: "Budgeted User" });
    upsertBudget("user", user.id, 0);

    const result = canClaim("agent-1", NOW);

    expect(result.allowed).toBe(true);
  });

  test("/mcp-user task is refused at worker admission when user budget is spent", async () => {
    const server = createMcpUserTestServer();
    const port = await listen(server);
    try {
      const lead = createAgent({ name: "lead", isLead: true, status: "idle", maxTasks: 1 });
      const worker = createAgent({ name: "worker", isLead: false, status: "idle", maxTasks: 1 });
      const user = createUser({ name: "MCP Budget User", dailyBudgetUsd: 0.5 });
      upsertBudget("user", user.id, 0.5);
      const token = mintToken(user.id, "qa", ACTOR);
      const baseUrl = `http://127.0.0.1:${port}`;
      const sessionId = await initializeMcpUser(baseUrl, token.plaintext);

      const sent = await mcpPost(
        baseUrl,
        token.plaintext,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "send-task",
            arguments: { task: "Phase 6 budget QA task" },
          },
        },
        sessionId,
      );
      expect(sent.response.status).toBe(200);
      const payload = sent.payload as {
        result: { structuredContent: { task: { id: string; requestedByUserId?: string } } };
      };
      const taskId = payload.result.structuredContent.task.id;
      expect(payload.result.structuredContent.task.requestedByUserId).toBe(user.id);

      createSessionCost({
        sessionId: `sess-${crypto.randomUUID()}`,
        taskId,
        agentId: worker.id,
        totalCostUsd: 0.5,
        durationMs: 1000,
        numTurns: 1,
        model: "test-model",
      });

      const firstPoll = await callPoll(worker.id);
      expect(firstPoll.status).toBe(200);
      if ("error" in firstPoll.body) throw new Error("unexpected poll error");
      expect(firstPoll.body.trigger?.type).toBe("budget_refused");
      expect((firstPoll.body.trigger as { cause: string }).cause).toBe("user");
      expect((firstPoll.body.trigger as { userSpend: number }).userSpend).toBe(0.5);
      expect((firstPoll.body.trigger as { userBudget: number }).userBudget).toBe(0.5);
      expect(getTaskById(taskId)?.status).toBe("unassigned");

      const firstDedup = getDb()
        .prepare<{ follow_up_task_id: string | null; user_spend_usd: number | null }, [string]>(
          "SELECT follow_up_task_id, user_spend_usd FROM budget_refusal_notifications WHERE task_id = ?",
        )
        .get(taskId);
      expect(firstDedup?.user_spend_usd).toBe(0.5);
      expect(firstDedup?.follow_up_task_id).toBeTruthy();
      const firstFollowUpId = firstDedup?.follow_up_task_id;
      expect(firstFollowUpId ? getTaskById(firstFollowUpId)?.agentId : null).toBe(lead.id);

      const secondPoll = await callPoll(worker.id);
      expect(secondPoll.status).toBe(200);
      if ("error" in secondPoll.body) throw new Error("unexpected poll error");
      expect(secondPoll.body.trigger?.type).toBe("budget_refused");
      const notificationCount = getDb()
        .prepare<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM budget_refusal_notifications WHERE task_id = ?",
        )
        .get(taskId);
      expect(notificationCount?.count).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
