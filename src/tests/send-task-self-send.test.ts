// send-task refuses an agent session that targets itself, but a script runs as its owner (a
// scheduled script as the schedule's creator), so a Lead-owned script must be able to file
// work for the Lead. Script calls reach the tool through /api/mcp-bridge as `script-sdk`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { handleMcpBridge } from "../http/mcp-bridge";
import { getPathSegments } from "../http/utils";
import { sendTaskHandler } from "../tools/send-task";
import { ownerCtx } from "../tools/task-tool-ctx";
import { getRequestInfo } from "../tools/utils";

const TEST_DB_PATH = "./test-send-task-self-send.sqlite";

let server: Server;
let baseUrl: string;
let leadId = "";

const selfSendArgs = (agentId: string) => ({
  task: "x mention to triage",
  agentId,
  routingReason: "skill" as const,
  routingNote: "Lead triages mentions itself",
  offerMode: false,
  allowDuplicate: true,
});

async function tasksFor(agentId: string): Promise<number> {
  return (await getDbClient().get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM agent_tasks WHERE agentId = ?",
    [agentId],
  ))!.c;
}

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  leadId = (
    await createAgent({ name: "self-send-lead", isLead: true, status: "idle", maxTasks: 5 })
  ).id;
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const ok = await handleMcpBridge(
      req,
      res,
      getPathSegments(req.url || ""),
      undefined,
      myAgentId,
    );
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB_PATH + suffix);
    } catch {
      // ignore
    }
  }
});

describe("send-task self-send guard", () => {
  test("a script sending a task to its own agent succeeds", async () => {
    const before = await tasksFor(leadId);
    const res = await fetch(`${baseUrl}/api/mcp-bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agent-id": leadId },
      body: JSON.stringify({ tool: "send-task", args: selfSendArgs(leadId) }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; message?: string };
    expect(body.message).not.toContain("Cannot send a task to yourself");
    expect(body.success).toBe(true);
    expect(await tasksFor(leadId)).toBe(before + 1);
  });

  test("an agent session sending a task to itself is still refused", async () => {
    const before = await tasksFor(leadId);
    // An MCP session's meta carries no origin mark, so getRequestInfo reports `mcp`.
    const info = getRequestInfo({
      sessionId: "session-1",
      requestInfo: { headers: { "x-agent-id": leadId } },
    } as unknown as Parameters<typeof getRequestInfo>[0]);
    expect(info.callOrigin).toBe("mcp");
    const result = await sendTaskHandler(ownerCtx(info), selfSendArgs(leadId));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Cannot send a task to yourself");
    expect(await tasksFor(leadId)).toBe(before);
  });
});
