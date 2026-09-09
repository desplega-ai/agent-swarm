import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

function contentText(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const record = asRecord(item);
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("\n");
}

export const mcpSurface: Scenario = {
  name: "mcp-surface",
  async run(ctx) {
    const register = await ctx.api("POST", "/api/agents", {
      body: { name: `e2e-mcp-${ctx.nonce}`, role: "worker", status: "online" },
    });
    expectStatus(register, [201], "register MCP agent");
    const agentId = asRecord(register.json).id;
    expect(typeof agentId === "string", "MCP agent response has no id");

    const connection = await ctx.connectMcp(agentId);
    try {
      const tools = await connection.listTools();
      expect(tools.length > 0, "MCP tools/list returned no tools");
      expect(
        tools.every((tool) => tool.inputSchema),
        "An MCP tool has no inputSchema",
      );

      const info = asRecord(await connection.callTool("my-agent-info", {}));
      expect(info.isError !== true, "my-agent-info returned isError");
      const text = contentText(info);
      const structured = asRecord(info.structuredContent);
      expect(text.length > 0, "my-agent-info returned empty text content");
      expect(
        typeof structured.message === "string" && structured.message.length > 0,
        "my-agent-info returned no structured message",
      );
      expect(text.includes(structured.message), "MCP text does not include the structured message");

      const poolMarker = `pool ${ctx.nonce}`;
      const create = await ctx.api("POST", "/api/tasks", {
        body: { task: poolMarker, source: "api" },
      });
      expectStatus(create, [201], "create pool task");
      const taskId = asRecord(create.json).id;
      expect(typeof taskId === "string", "Pool task response has no id");

      const listed = asRecord(
        await connection.callTool("get-tasks", { unassigned: true, includeFull: true }),
      );
      expect(listed.isError !== true, "get-tasks returned isError");
      expect(JSON.stringify(listed).includes(taskId), "get-tasks did not list the pool task");
      const claimed = asRecord(
        await connection.callTool("task-action", { action: "claim", taskId }),
      );
      expect(claimed.isError !== true, "task-action claim returned isError");

      let response = await ctx.api("GET", `/api/tasks/${taskId}`);
      expectStatus(response, [200], "read claimed task");
      expect(asRecord(response.json).agentId === agentId, "Claimed task has the wrong agent id");

      const progress = asRecord(
        await connection.callTool("store-progress", {
          taskId,
          progress: `MCP progress ${ctx.nonce}`,
        }),
      );
      expect(progress.isError !== true, "store-progress returned isError");
      response = await ctx.api("POST", `/api/tasks/${taskId}/finish`, {
        agentId,
        body: { status: "completed", output: `MCP completed ${ctx.nonce}` },
      });
      expectStatus(response, [200], "finish MCP pool task");

      let rejected = false;
      try {
        const missing = asRecord(await connection.callTool("e2e-tool-does-not-exist", {}));
        rejected = missing.isError === true;
      } catch {
        rejected = true;
      }
      expect(rejected, "Unknown MCP tool did not return a graceful error");
      expect(
        (await connection.listTools()).length > 0,
        "MCP transport failed after the unknown tool call",
      );
    } finally {
      await connection.close();
    }
  },
};
