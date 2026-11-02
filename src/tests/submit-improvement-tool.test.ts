import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, initDb, upsertSwarmConfig } from "../be/db";
import { getImprovement, listImprovements } from "../be/improvements";
import { registerSubmitImprovementTool } from "../tools/submit-improvement";

const TEST_DB_PATH = "./test-submit-improvement-tool.sqlite";

type ToolResult = {
  isError?: boolean;
  structuredContent: { success: boolean; id?: string; status?: string; message?: string };
};

let callTool: (args: unknown, agentId: string) => Promise<ToolResult>;
let workerId = "";
const originalFetch = globalThis.fetch;
let fetchCalls = 0;

describe("submit-improvement tool", () => {
  beforeAll(async () => {
    initDb(TEST_DB_PATH);
    workerId = (await createAgent({ name: "imp-tool-worker", isLead: false, status: "idle" })).id;
    const server = new McpServer({ name: "submit-improvement-test", version: "1.0.0" });
    registerSubmitImprovementTool(server);
    const tool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown, extra: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools["submit-improvement"];
    if (!tool) throw new Error("submit-improvement tool was not registered");
    callTool = async (args, agentId) =>
      (await tool.handler(args, {
        sessionId: "submit-improvement-test",
        requestInfo: { headers: { "x-agent-id": agentId } },
      })) as ToolResult;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
    }
  });

  beforeEach(async () => {
    fetchCalls = 0;
    await upsertSwarmConfig({ scope: "global", key: "IMPROVEMENTS_ENABLED", value: "true" });
  });

  test("drafts a pending row and sends nothing", async () => {
    const result = await callTool({ text: "Group tasks by repo" }, workerId);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.status).toBe("pending_approval");
    const row = await getImprovement(result.structuredContent.id ?? "");
    expect(row).toMatchObject({
      status: "pending_approval",
      source: "mcp",
      requestedByAgentId: workerId,
      approvedBy: null,
      email: null,
    });
    expect(fetchCalls).toBe(0);
  });

  test("refuses when the switch is off", async () => {
    await upsertSwarmConfig({ scope: "global", key: "IMPROVEMENTS_ENABLED", value: "false" });
    const before = (await listImprovements()).length;
    const result = await callTool({ text: "Anything" }, workerId);
    expect(result.isError).toBe(true);
    expect((await listImprovements()).length).toBe(before);
    expect(fetchCalls).toBe(0);
  });
});
