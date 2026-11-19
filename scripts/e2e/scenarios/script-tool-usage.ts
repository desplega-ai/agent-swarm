import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { cancelQuietly, createAssignedTask } from "./core-helpers";
import { expectRunOk, registerAgent, runScript } from "./script-helpers";

type ToolRow = { tool: unknown; calls: unknown };

function toolUseLine(tool: string, index: number): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: `tu-${index}`, name: tool, input: {} }] },
  });
}

async function storeLogs(ctx: ScenarioContext, taskId: string, sessionId: string, lines: string[]) {
  const response = await ctx.api("POST", "/api/session-logs", {
    body: { sessionId, iteration: 1, taskId, cli: "claude", lines },
  });
  expectStatus(response, [201], `store session logs for ${sessionId}`);
}

async function toolUsage(
  ctx: ScenarioContext,
  agentId: string,
  args: Record<string, unknown>,
  label: string,
): Promise<{ result: Record<string, unknown>; tools: ToolRow[] }> {
  const run = await runScript(ctx, agentId, { name: "tool-usage", args }, label);
  expectRunOk(run, label);
  const result = asRecord(run.result);
  expect(Array.isArray(result.tools), `${label}: no tools array in ${JSON.stringify(result)}`);
  return { result, tools: result.tools as ToolRow[] };
}

/**
 * Flow `script-tool-usage`: the seeded `tool-usage` script counts tool_use lines from
 * session_logs, filters by the agent that owns the task, and passes every argument as a
 * bound SQL parameter. An agentId that holds SQL text matches no agent and adds no rows.
 */
export const scriptToolUsage: Scenario = {
  name: "script-tool-usage",
  order: 505,
  async run(ctx) {
    const agentA = await registerAgent(ctx, "tool-usage-a");
    const agentB = await registerAgent(ctx, "tool-usage-b");
    const toolA = `e2e_tool_a_${ctx.nonce}`;
    const toolB = `e2e_tool_b_${ctx.nonce}`;
    const taskA = await createAssignedTask(ctx, agentA, `tool-usage a ${ctx.nonce}`);
    const taskB = await createAssignedTask(ctx, agentB, `tool-usage b ${ctx.nonce}`);

    try {
      await storeLogs(ctx, taskA, `tool-usage-a-${ctx.nonce}`, [
        toolUseLine(toolA, 1),
        toolUseLine(toolA, 2),
        toolUseLine(toolA, 3),
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        }),
      ]);
      await storeLogs(ctx, taskB, `tool-usage-b-${ctx.nonce}`, [
        toolUseLine(toolB, 1),
        toolUseLine(toolB, 2),
      ]);

      // ── agent filter: only agent A's tool, with its call count ──────────────────────
      const own = await toolUsage(ctx, agentA, { agentId: agentA, days: 1 }, "tool-usage agent A");
      expect(
        own.result.agentId === agentA,
        `tool-usage agent A: agentId echo ${String(own.result.agentId)}`,
      );
      expect(
        own.tools.length === 1 && own.tools[0]?.tool === toolA && own.tools[0]?.calls === 3,
        `tool-usage agent A: expected [${toolA} x3], got ${JSON.stringify(own.tools)}`,
      );
      expect(
        own.result.totalCalls === 3,
        `tool-usage agent A: totalCalls ${String(own.result.totalCalls)}`,
      );

      // ── no filter: both agents' tools appear ─────────────────────────────────────────
      const all = await toolUsage(ctx, agentA, { days: 1, limit: 1000 }, "tool-usage all agents");
      const count = (tool: string) => all.tools.find((row) => row.tool === tool)?.calls;
      expect(
        count(toolA) === 3 && count(toolB) === 2,
        `tool-usage all agents: expected ${toolA}=3 and ${toolB}=2, got ${toolA}=${String(count(toolA))} ${toolB}=${String(count(toolB))}`,
      );

      // ── limit is applied ─────────────────────────────────────────────────────────────
      const top = await toolUsage(ctx, agentA, { days: 1, limit: 1 }, "tool-usage limit 1");
      expect(top.tools.length === 1, `tool-usage limit 1: got ${top.tools.length} rows`);

      // ── SQL text in agentId is a plain value: no rows, no error ─────────────────────
      for (const agentId of [
        `${agentA}' OR '1'='1`,
        `${agentA}') UNION SELECT name, 1 FROM agents --`,
      ]) {
        const quoted = await toolUsage(
          ctx,
          agentA,
          { agentId, days: 1 },
          "tool-usage quoted agentId",
        );
        expect(
          quoted.tools.length === 0 && quoted.result.totalCalls === 0,
          `tool-usage quoted agentId: expected no rows, got ${JSON.stringify(quoted.tools)}`,
        );
        expect(
          quoted.result.error === undefined && quoted.result.agentId === agentId,
          `tool-usage quoted agentId: unexpected result ${JSON.stringify(quoted.result).slice(0, 300)}`,
        );
      }
    } finally {
      await cancelQuietly(ctx, taskA);
      await cancelQuietly(ctx, taskB);
    }
  },
};
