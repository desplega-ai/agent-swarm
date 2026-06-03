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

  const agentFilter = agentId ? `AND agent_id = '${agentId}'` : "";
  const query = `
    SELECT tool_name, count(*) as calls
    FROM session_logs
    WHERE tool_name IS NOT NULL
      AND created_at > datetime('now', '-${days} days')
      ${agentFilter}
    GROUP BY tool_name
    ORDER BY calls DESC
    LIMIT ${limit}
  `;

  const res: any = await ctx.swarm.db_query({ query });
  const payload = res?.data ?? res;
  const rows: any[] = payload?.rows ?? [];

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
