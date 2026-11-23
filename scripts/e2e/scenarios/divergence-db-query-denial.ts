import { sql } from "../db";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { callTool, expectToolError, expectToolOk, registerWorker, withMcp } from "./core-helpers";

// The credential tables db-query must never read, through either surface.
const DENIED = [
  "codex_oauth_device_flows",
  "oauth_apps",
  "oauth_authorizations",
  "oauth_pending",
  "script_apis",
  "session_tokens",
  "user_tokens",
];

const WRITES = (taskId: string) => [
  `INSERT INTO agent_tasks (id, task, status) VALUES ('x-${taskId}', 'injected', 'pending')`,
  `UPDATE agent_tasks SET status = 'failed' WHERE id = '${taskId}'`,
  `DELETE FROM agent_tasks WHERE id = '${taskId}'`,
  "DROP TABLE agent_tasks",
  "DELETE FROM user_tokens",
];

// POST /api/db-query and the db-query MCP tool share one guard: a SELECT on a
// credential table is refused naming the table, a write is refused and changes
// nothing, and an allowed table still answers.
export const divergenceDbQueryDenial: Scenario = {
  name: "divergence-db-query-denial",
  order: 9_468,
  async run(ctx) {
    const agentId = await registerWorker(ctx, "db-query-denial");
    const created = await ctx.api("POST", "/api/tasks", {
      body: {
        task: `db-query denial probe ${ctx.nonce}`,
        agentId,
        routingReason: "human_pinned",
        source: "ui",
      },
    });
    expectStatus(created, [201], "create a task to read back");
    const taskId = asString(asRecord(created.json).id, "task id");

    for (const table of DENIED) {
      for (const query of [
        `SELECT * FROM ${table}`,
        `SELECT COUNT(*) AS n FROM ${table}`,
        `SELECT t.id FROM agent_tasks t WHERE EXISTS (SELECT 1 FROM ${table})`,
      ]) {
        const response = await ctx.api("POST", "/api/db-query", { body: { sql: query } });
        expectStatus(response, [400], `HTTP db-query on ${table}`);
        const error = String(asRecord(response.json).error);
        expect(
          error.startsWith(`db-query cannot read ${table}:`) && error.includes("credentials"),
          `HTTP refusal for ${table} reads: ${error}`,
        );
      }
    }

    for (const query of WRITES(taskId)) {
      const response = await ctx.api("POST", "/api/db-query", { body: { sql: query } });
      expectStatus(response, [400], `HTTP db-query write: ${query}`);
      expect(typeof asRecord(response.json).error === "string", `no error text for ${query}`);
    }

    const allowed = await ctx.api("POST", "/api/db-query", {
      body: { sql: "SELECT id FROM agent_tasks LIMIT 1" },
    });
    expectStatus(allowed, [200], "HTTP db-query on an allowed table");
    const result = asRecord(allowed.json);
    expect(
      JSON.stringify(result.columns) === '["id"]' &&
        Array.isArray(result.rows) &&
        result.rows.length === 1 &&
        result.total === 1,
      `allowed query answered ${allowed.text.slice(0, 300)}`,
    );
    const byId = await ctx.api("POST", "/api/db-query", {
      body: { sql: "SELECT id FROM agent_tasks WHERE id = $1", params: [taskId] },
    });
    expectStatus(byId, [200], "HTTP db-query with a parameter");
    expect(
      JSON.stringify(asRecord(byId.json).rows) === JSON.stringify([[taskId]]),
      `parameterized query answered ${byId.text.slice(0, 300)}`,
    );

    await withMcp(ctx, agentId, async (conn) => {
      for (const table of DENIED) {
        await expectToolError(
          conn,
          "db-query",
          { sql: `SELECT * FROM ${table}` },
          `db-query cannot read ${table}:`,
        );
      }
      for (const query of WRITES(taskId)) {
        const outcome = await callTool(conn, "db-query", { sql: query });
        expect(outcome.isError, `MCP db-query ran a write: ${query}`);
      }
      const outcome = await expectToolOk(conn, "db-query", {
        sql: "SELECT id FROM agent_tasks LIMIT 1",
      });
      expect(
        JSON.stringify(outcome.data.columns) === '["id"]' && outcome.data.total === 1,
        `MCP allowed query answered ${JSON.stringify(outcome.data)}`,
      );
    });

    // No write landed: the probe task is intact and nothing was injected.
    const row = ctx.db.get<{ status: string }>(
      sql`SELECT status FROM agent_tasks WHERE id = ${taskId}`,
    );
    expect(row?.status !== undefined && row.status !== "failed", `probe task is ${row?.status}`);
    const injected = ctx.db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM agent_tasks WHERE id = ${`x-${taskId}`}`,
    );
    expect(Number(injected?.n) === 0, "an INSERT through db-query landed");
  },
};
