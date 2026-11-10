import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getSessionCostsByTaskId,
  getTaskLineage,
  initDb,
  insertPricingRow,
  insertSessionCost,
  upsertSwarmConfig,
} from "../be/db";
import { registerSystemOneDecideTool } from "../tools/system-one-decide";
import { markExtensionRequestOrigin } from "../tools/utils";

// A SystemOne decision made for a task lands on that task's session costs as a
// `system-one` row. Workers AI is a mocked fetch; nothing reaches the network.

const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";
const realFetch = globalThis.fetch;
let agentId: string;
let otherAgentId: string;
let taskId: string;
let tool: any;

const QUESTION = {
  provider: "cloudflare",
  model: "clef",
  state: { text: "lol nice" },
  questions: {
    reason: {
      type: "choice",
      instructions: "Does this need a reply?",
      criteria: { reply: "needs a reply", skip: "needs no reply" },
    },
  },
};

const call = (
  args: Record<string, unknown>,
  headers: Record<string, string>,
  extension = false,
) => {
  const extra = { sessionId: "s", requestInfo: { headers } };
  return tool.handler(
    { ...QUESTION, ...args },
    extension ? markExtensionRequestOrigin(extra) : extra,
  );
};

beforeAll(async () => {
  initDb(":memory:");
  agentId = (await createAgent({ name: "clef-caller", isLead: false, status: "busy" })).id;
  otherAgentId = (await createAgent({ name: "other", isLead: false, status: "busy" })).id;
  await upsertSwarmConfig({ scope: "global", key: "CLOUDFLARE_ACCOUNT_ID", value: CF_ACCOUNT });
  await upsertSwarmConfig({
    scope: "global",
    key: "CLOUDFLARE_API_TOKEN",
    value: "cf-token",
    isSecret: true,
  });
  const server = new McpServer({ name: "decide-cost", version: "1" });
  registerSystemOneDecideTool(server);
  tool = (server as any)._registeredTools["system-one-decide"];
});
afterAll(() => closeDb());

beforeEach(async () => {
  taskId = (await createTaskExtended("Content Writer post", { agentId, source: "mcp" })).id;
  globalThis.fetch = (async () =>
    Response.json({
      result: {
        model: "clef",
        answers: {
          reason: {
            type: "choice",
            choice: "reply",
            probabilities: { reply: 0.9, skip: 0.1 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 400, output_tokens: 20 },
      },
      success: true,
      errors: [],
      messages: [],
    })) as unknown as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await getDbClient().run("DELETE FROM pricing WHERE provider = 'system-one'");
});

describe("system-one-decide session cost", () => {
  test("X-Source-Task-Id charges the caller's task, unpriced with no rate row", async () => {
    const result = await call({}, { "x-agent-id": agentId, "x-source-task-id": taskId });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.cost).toEqual({
      taskId,
      costUsd: 0,
      costSource: "unpriced",
    });
    const rows = await getSessionCostsByTaskId(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "system-one",
      model: "cloudflare/clef",
      inputTokens: 400,
      outputTokens: 20,
      totalCostUsd: 0,
      costSource: "unpriced",
      agentId,
    });
  });

  test("a system-one pricing row prices the decision and the task total includes it", async () => {
    for (const [tokenClass, price] of [
      ["input", 1],
      ["output", 10],
    ] as const) {
      await insertPricingRow({
        provider: "system-one",
        model: "cloudflare/clef",
        tokenClass,
        effectiveFrom: 0,
        pricePerMillionUsd: price,
      });
    }
    const result = await call({ taskId }, { "x-agent-id": agentId });
    const expected = (400 * 1 + 20 * 10) / 1_000_000;
    expect(result.structuredContent.cost.costSource).toBe("pricing-table");
    expect(result.structuredContent.cost.costUsd).toBeCloseTo(expected, 12);
    const [row] = await getSessionCostsByTaskId(taskId);
    expect(row).toMatchObject({ kind: "system-one", costSource: "pricing-table" });
    // The lineage view sums every session_costs row of the task.
    const listed = (await getTaskLineage(taskId))?.tasks.find((t) => t.id === taskId);
    expect(listed?.totalCostUsd).toBeCloseTo(expected, 12);
  });

  test("no task in scope records nothing", async () => {
    const result = await call({}, { "x-agent-id": agentId });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.cost).toBeUndefined();
    expect(await getSessionCostsByTaskId(taskId)).toHaveLength(0);
  });

  test("a caller cannot charge another agent's task", async () => {
    const result = await call({ taskId }, { "x-agent-id": otherAgentId });
    expect(result.isError).toBe(true);
    expect(await getSessionCostsByTaskId(taskId)).toHaveLength(0);
  });

  test("an extension charges the task of the event it handles", async () => {
    const result = await call({ taskId }, { "x-agent-id": otherAgentId }, true);
    expect(result.structuredContent.cost?.taskId).toBe(taskId);
    const [row] = await getSessionCostsByTaskId(taskId);
    // The row belongs to the task's agent, not the extension's identity.
    expect(row).toMatchObject({ kind: "system-one", agentId });
  });

  test("a failed cost write still returns the decision", async () => {
    // A pool task has no agent, so the row falls back to the caller's id; an
    // unregistered extension identity then fails the agentId foreign key.
    const poolTask = (await createTaskExtended("Pool post", { source: "mcp" })).id;
    const result = await call({ taskId: poolTask }, { "x-agent-id": crypto.randomUUID() }, true);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.answers.reason.choice).toBe("reply");
    expect(result.structuredContent.cost).toBeUndefined();
    expect(await getSessionCostsByTaskId(poolTask)).toHaveLength(0);
  });

  test("X-Source-Task-Id of another agent's task records nothing", async () => {
    const result = await call({}, { "x-agent-id": otherAgentId, "x-source-task-id": taskId });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.cost).toBeUndefined();
    expect(await getSessionCostsByTaskId(taskId)).toHaveLength(0);
  });

  test("harness rows default to kind harness", async () => {
    await insertSessionCost({
      sessionId: "harness-session",
      taskId,
      agentId,
      totalCostUsd: 1,
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      numTurns: 1,
      model: "claude-opus",
    });
    const [row] = await getSessionCostsByTaskId(taskId);
    expect(row?.kind).toBe("harness");
  });
});
