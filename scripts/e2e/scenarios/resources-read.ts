import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

export const resourcesRead: Scenario = {
  name: "resources-read",
  order: 695,
  async run(ctx) {
    // Phase 1 exposes reads only. Nonempty fake fixtures use the minimal wire suite.
    const agent = await ctx.api("POST", "/api/agents", {
      body: { name: `resource-reader-${ctx.nonce}`, status: "online" },
    });
    expectStatus(agent, [201], "register resource reader");
    const agentId = asString(asRecord(agent.json).id, "resource reader id");
    const other = await ctx.api("POST", "/api/agents", {
      body: { name: `resource-other-${ctx.nonce}`, status: "online" },
    });
    expectStatus(other, [201], "register other resource reader");
    const otherId = asString(asRecord(other.json).id, "other reader id");
    const createTask = async (id: string) => {
      const result = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `Resource source ${ctx.nonce}`,
          agentId: id,
          routingReason: "human_pinned",
          source: "api",
        },
      });
      expectStatus(result, [201], "create resource source task");
      return asString(asRecord(result.json).id, "source task id");
    };
    const taskId = await createTask(agentId);
    const foreignTaskId = await createTask(otherId);
    expectStatus(
      await ctx.api("GET", "/api/resources", { apiKey: null }),
      [401],
      "deny anonymous resource read",
    );
    expectStatus(
      await ctx.api("GET", "/api/resources", { agentId }),
      [403],
      "require explicit resource task",
    );
    const listed = await ctx.api("GET", `/api/resources?taskId=${taskId}&kind=sandbox&limit=10`, {
      agentId,
    });
    expectStatus(listed, [200], "list resources for verified task");
    expect(asRecords(listed.json, "resources").length === 0, "fresh task has no resources");
    expect(listed.headers.get("cache-control") === "no-store", "resource lists disable caching");
    expectStatus(
      await ctx.api(
        "GET",
        `/api/resources?taskId=${foreignTaskId}&requestedByUserId=forged&ownerUserId=forged`,
        { agentId },
      ),
      [403],
      "deny forged task requester",
    );
    expectStatus(
      await ctx.api("GET", `/api/resources/${crypto.randomUUID()}?taskId=${taskId}`, { agentId }),
      [404],
      "hide unavailable resource details",
    );
    expectStatus(
      await ctx.api("GET", `/api/resources?taskId=${taskId}&limit=0`, { agentId }),
      [400],
      "validate resource list bounds",
    );
    const mcp = await ctx.connectMcp(agentId);
    try {
      const result = await mcp.callTool("resource-list", { taskId });
      expect(result.isError !== true, "MCP resource list succeeds");
      expect(
        asRecords(result.structuredContent, "resources").length === 0,
        "MCP list matches REST",
      );
      const denied = await mcp.callTool("resource-list", { taskId: foreignTaskId });
      expect(denied.isError === true, "MCP denies foreign tasks");
    } finally {
      await mcp.close();
    }
    for (const id of [taskId, foreignTaskId]) {
      expectStatus(
        await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: {} }),
        [200],
        "cancel resource fixture task",
      );
    }
  },
};
