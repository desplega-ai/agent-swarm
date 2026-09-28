import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createApprovalRequest,
  createTaskExtended,
  getApprovalRequestById,
  initDb,
} from "../be/db";
import { registerCancelApprovalRequestTool } from "../tools/cancel-approval-request";

const TEST_DB_PATH = "./test-cancel-approval-request-tool.sqlite";

type ToolResult = {
  isError?: boolean;
  structuredContent: { success: boolean; alreadyCancelled?: boolean; runCancelled?: boolean };
};

let callTool: (args: unknown, agentId: string) => Promise<ToolResult>;
let leadId = "";
let ownerId = "";
let workerId = "";

async function makeRequest() {
  const sourceTask = await createTaskExtended("source", { agentId: ownerId, source: "mcp" });
  const id = crypto.randomUUID();
  await createApprovalRequest({
    id,
    title: "Tool cancel",
    questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
    approvers: { policy: "any" },
    sourceTaskId: sourceTask.id,
  });
  return id;
}

describe("cancel-approval-request tool", () => {
  beforeAll(async () => {
    initDb(TEST_DB_PATH);
    leadId = (await createAgent({ name: "tool-lead", isLead: true, status: "idle" })).id;
    ownerId = (await createAgent({ name: "tool-owner", isLead: false, status: "idle" })).id;
    workerId = (await createAgent({ name: "tool-worker", isLead: false, status: "idle" })).id;
    const server = new McpServer({ name: "cancel-approval-request-test", version: "1.0.0" });
    registerCancelApprovalRequestTool(server);
    const tool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown, extra: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools["cancel-approval-request"];
    if (!tool) throw new Error("cancel-approval-request tool was not registered");
    callTool = async (args, agentId) =>
      (await tool.handler(args, {
        sessionId: "cancel-approval-request-test",
        requestInfo: { headers: { "x-agent-id": agentId } },
      })) as ToolResult;
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
    }
  });

  test("a lead cancels a pending request, then a second call is a no-op", async () => {
    const requestId = await makeRequest();

    const first = await callTool({ requestId, reason: "not needed" }, leadId);
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent.alreadyCancelled).toBe(false);
    const row = await getApprovalRequestById(requestId);
    expect(row!.status).toBe("cancelled");
    expect(row!.resolvedBy).toBe(leadId);
    expect(row!.resolutionReason).toBe("not needed");

    const second = await callTool({ requestId }, leadId);
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent.alreadyCancelled).toBe(true);
  });

  test("a worker that does not own the source task gets a tool error", async () => {
    const requestId = await makeRequest();

    const result = await callTool({ requestId }, workerId);

    expect(result.isError).toBe(true);
    expect((await getApprovalRequestById(requestId))!.status).toBe("pending");
  });

  test("the owner agent may cancel", async () => {
    const requestId = await makeRequest();
    const result = await callTool({ requestId }, ownerId);
    expect(result.isError).toBeFalsy();
    expect((await getApprovalRequestById(requestId))!.status).toBe("cancelled");
  });
});
