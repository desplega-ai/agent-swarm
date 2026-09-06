/**
 * End-to-end regression for the #1316 / #1276 interaction: a session-UI
 * follow-up (`source: "ui"`, `parentTaskId` set, no `agentId`) must land on
 * the Lead, and the Lead must still be able to delegate onward from that
 * follow-up to an ordinary (non-Lead) worker — even when the follow-up's
 * parent carries a worker-specific routing affinity.
 *
 * Before the fix: #1316 stamped `leadOnly: true` on the follow-up so the
 * Lead could be direct-assigned despite the inherited worker affinity; #1276
 * then made `leadOnly` a one-way ratchet, so every `send-task` made from
 * inside that follow-up was forced `leadOnly` too and rejected any non-Lead
 * target. The fix separates inherited PROVENANCE affinity (informational —
 * "this continuation came from agent X") from a caller-declared or
 * lead-only-ratcheted REQUIREMENT; only the latter gates direct
 * assignment/offer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { closeDb, createAgent, createTaskExtended, initDb, updateAgentProfile } from "../be/db";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerSendTaskTool } from "../tools/send-task";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-ui-followup-lead-delegation.sqlite";

let server: Server;
let baseUrl: string;
let leadAgentId: string;
let originalWorkerId: string;
let differentWorkerId: string;

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    setRequestAuth(req, { kind: "operator", fingerprint: "ui-followup-lead-delegation-test" });
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    const callerAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleTasks(req, res, pathSegments, query, callerAgentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function callSendTask(
  mcpServer: McpServer,
  args: Record<string, unknown>,
  callerAgentId: string,
  sourceTaskId?: string,
): Promise<CallToolResult> {
  const tools = (mcpServer as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools["send-task"];
  if (!tool) throw new Error("send-task not registered");
  const headers: Record<string, string> = { "x-agent-id": callerAgentId };
  if (sourceTaskId) headers["x-source-task-id"] = sourceTaskId;
  return tool.handler(args, { sessionId: "test-session", requestInfo: { headers } });
}

function structuredOf(result: CallToolResult) {
  return result.structuredContent as {
    success: boolean;
    task?: { id: string; agentId?: string | null };
    message: string;
  };
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  closeDb();
  initDb(TEST_DB_PATH);

  leadAgentId = (await createAgent({ name: "ui-followup-lead", isLead: true, status: "idle" })).id;
  originalWorkerId = (
    await createAgent({ name: "ui-followup-original-worker", isLead: false, status: "idle" })
  ).id;
  await updateAgentProfile(originalWorkerId, {
    role: "Implementation Engineer / Coder",
    capabilities: ["typescript", "javascript", "nodejs", "git", "worktrees"],
  });
  differentWorkerId = (
    await createAgent({ name: "ui-followup-different-worker", isLead: false, status: "idle" })
  ).id;
  await updateAgentProfile(differentWorkerId, { role: "researcher", capabilities: [] });

  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("session-UI follow-up → Lead → onward delegation", () => {
  const mcpServer = new McpServer({ name: "test-ui-followup-lead-delegation", version: "1.0.0" });
  registerSendTaskTool(mcpServer);

  test("a UI follow-up lands on the Lead, and the Lead can still delegate it to a non-Lead worker lacking the parent's capabilities", async () => {
    // Parent task carries the ORIGINAL worker's provenance affinity — not a
    // caller-declared requirement.
    const parent = await createTaskExtended("worker-owned session", {
      agentId: originalWorkerId,
      routingAffinity: {
        sourceAgentId: originalWorkerId,
        role: "Implementation Engineer / Coder",
        capabilities: ["typescript", "javascript", "nodejs", "git", "worktrees"],
      },
    });

    // Leg 1: the session-UI follow-up must be assigned to the Lead despite
    // the inherited worker-specific affinity, and must NOT be stamped
    // Lead-only.
    const followUp = await api("POST", "/api/tasks", {
      task: "continue this session from the UI",
      parentTaskId: parent.id,
      source: "ui",
    });
    expect(followUp.status).toBe(201);
    expect(followUp.body.agentId).toBe(leadAgentId);
    expect(followUp.body.routingAffinity?.leadOnly).not.toBe(true);

    // Leg 2 (the actual bug): the Lead, working the follow-up, delegates to
    // an ordinary worker that does NOT hold the original worker's
    // capabilities. This must succeed — the inherited affinity is
    // provenance, not a requirement.
    const delegated = await callSendTask(
      mcpServer,
      { task: "please pick this up", agentId: differentWorkerId, allowDuplicate: true },
      leadAgentId,
      followUp.body.id,
    );
    const s = structuredOf(delegated);
    expect(s.success).toBe(true);
    expect(s.task?.agentId).toBe(differentWorkerId);
  });
});
