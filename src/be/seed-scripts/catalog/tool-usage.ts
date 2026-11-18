import { z } from "zod";

export const argsSchema = z.object({
  days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Look back this many days (default 7)"),
  agentId: z.string().optional().describe("Filter by agent ID (default: all agents)"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Top N tools to return (default 20)"),
});

/** Tool usage histogram from session_logs — top tools by call count. */
export default async function toolUsage(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const days = parsed.data.days || 7;
  const limit = parsed.data.limit || 20;
  const agentId = parsed.data.agentId;

  // Tool names live inside the `content` JSON of session_logs (no dedicated
  // column). The `"type":"tool_use"` filter skips tool_result lines, and
  // instr/substr take the first tool name of each log line. session_logs has
  // no agent column: the agent filter goes through the task that owns the log.
  // Every value from args is a bound parameter.
  const params: unknown[] = [`-${days} days`];
  let agentFilter = "";
  if (agentId) {
    agentFilter = "AND taskId IN (SELECT id FROM agent_tasks WHERE agentId = ?)";
    params.push(agentId);
  }
  params.push(limit);
  const sql = `
    WITH tu AS (
      SELECT substr(content, instr(content, '"type":"tool_use"')) AS tail
      FROM session_logs
      WHERE content LIKE '%"type":"tool_use"%'
        AND createdAt > datetime('now', ?)
        ${agentFilter}
    ),
    nm AS (
      SELECT substr(tail, instr(tail, '"name":"') + 8) AS rest
      FROM tu WHERE instr(tail, '"name":"') > 0
    )
    SELECT substr(rest, 1, instr(rest, '"') - 1) AS tool_name, count(*) AS calls
    FROM nm
    GROUP BY tool_name
    ORDER BY calls DESC
    LIMIT ?
  `;

  const res: any = await ctx.swarm.db_query({ sql, params });
  const payload = res?.data ?? res;
  const columns: string[] = payload?.columns ?? [];
  const rows: any[] = (payload?.rows ?? []).map((row: any[]) =>
    Object.fromEntries(columns.map((column, index) => [column, row[index]])),
  );

  const totalCalls = rows.reduce((sum: number, r: any) => sum + (r.calls ?? 0), 0);

  return {
    days,
    agentId: agentId ?? "all",
    totalDistinctTools: rows.length,
    totalCalls,
    tools: rows.map((r: any) => ({
      tool: r.tool_name,
      calls: r.calls,
      pct: totalCalls > 0 ? Math.round((r.calls / totalCalls) * 1000) / 10 : 0,
    })),
  };
}
