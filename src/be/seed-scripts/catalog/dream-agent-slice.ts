import { z } from "zod";
import { getH2Anchors } from "../dream-schemas";

export const argsSchema = z.object({
  agentId: z.string().min(1).describe("Agent ID to reflect on"),
  days: z.number().int().positive().optional().describe("Lookback window in days (default 1)"),
  runId: z
    .string()
    .optional()
    .describe(
      "This dream run's workflow-run ID — excludes Dreaming's own tasks from the slice so reflection never reasons over the add-on's bookkeeping",
    ),
});

function rowsToObjects(response: any): any[] {
  const payload = response?.data ?? response;
  // A failed db_query must not read as a quiet day — an empty-but-successful
  // slice and an errored one are different facts, and reflection may only
  // reason over the former.
  if (response?.success === false || payload?.success === false) {
    throw new Error(`evidence query failed: ${payload?.error ?? response?.error ?? "unknown error"}`);
  }
  const columns: string[] = payload?.columns ?? [];
  return (payload?.rows ?? []).map((row: any) =>
    Array.isArray(row) ? Object.fromEntries(columns.map((column, index) => [column, row[index]])) : row,
  );
}

function truncate(value: unknown, limit: number): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** Gather a compact, evidence-backed reflection slice for one agent. */
export default async function dreamAgentSlice(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args || {});
  if (!parsed.success) return { error: `invalid args: ${parsed.error.message}` };
  const { agentId } = parsed.data;
  const days = parsed.data.days ?? 1;
  const windowModifier = `-${days} days`;
  const query = (sql: string, params: unknown[] = [agentId, windowModifier]) =>
    ctx.swarm.db_query({ sql, params }).then(rowsToObjects);

  // The reflection prompt says to use ONLY this slice as evidence, so Dreaming's
  // own reflection/critique tasks must not appear in it — otherwise a quiet agent
  // reflects on last night's bookkeeping and proposes changes from it. Excluded by
  // durable workflow ID (every run of the dream workflow, not just this one), the
  // same identity dream-gather's activity gate uses.
  const runId = parsed.data.runId;
  const selfRuns = `SELECT r.id FROM workflow_runs r
       WHERE r.workflowId = (SELECT workflowId FROM workflow_runs WHERE id = ?)`;
  const excludeSelfRuns = runId
    ? `AND (t.workflowRunId IS NULL OR t.workflowRunId NOT IN (${selfRuns}))`
    : "";
  // Tool events, skill invocations and session costs are task-scoped too, so the
  // same bookkeeping leaks through them: a quiet agent would otherwise see last
  // night's Dreaming tool calls, its `dreaming` skill invocation, and the cost of
  // running them. Rows with no taskId are not attributable to any run and stay.
  const excludeSelfTaskRows = (alias: string) =>
    runId
      ? `AND (${alias}.taskId IS NULL OR ${alias}.taskId NOT IN (
           SELECT t2.id FROM agent_tasks t2 WHERE t2.workflowRunId IN (${selfRuns})))`
      : "";
  const selfParams = runId ? [runId] : [];

  // julianday() on BOTH operands: stored timestamps are ISO ("...T12:00:00Z")
  // while datetime('now', ?) renders space-separated — lexicographic comparison
  // of the two formats sorts 'T' after ' ' and silently widens the window.
  const [tasks, tools, memories, costs, profiles, installedSkills, invokedSkills] = await Promise.all([
    query(
      `SELECT t.id, t.status, t.taskType, t.failureReason, t.createdAt, t.finishedAt,
              t.workflowRunStepId, COALESCE(wrs.retryCount, 0) AS retryCount
       FROM agent_tasks t
       LEFT JOIN workflow_run_steps wrs ON wrs.id = t.workflowRunStepId
       WHERE t.agentId = ?
             AND (julianday(t.createdAt) > julianday('now', ?)
                  OR julianday(COALESCE(t.finishedAt, t.lastUpdatedAt)) > julianday('now', ?))
             ${excludeSelfRuns}
       ORDER BY t.createdAt DESC LIMIT 40`,
      [agentId, windowModifier, windowModifier, ...selfParams],
    ),
    query(
      `SELECT json_extract(e.data, '$.toolName') AS tool, count(*) AS calls
       FROM events e
       WHERE e.agentId = ? AND e.category = 'tool' AND e.event = 'tool.start'
         AND julianday(e.createdAt) > julianday('now', ?)
         ${excludeSelfTaskRows("e")}
       GROUP BY tool ORDER BY calls DESC LIMIT 20`,
      [agentId, windowModifier, ...selfParams],
    ),
    query(
      `SELECT id, name, scope, source, accessCount, alpha, beta, createdAt,
              ROUND(alpha / (alpha + beta), 3) AS usefulness
       FROM agent_memory
       WHERE agentId = ? AND julianday(createdAt) > julianday('now', ?)
       ORDER BY createdAt DESC LIMIT 20`,
    ),
    query(
      `SELECT COUNT(*) AS sessions, ROUND(COALESCE(SUM(totalCostUsd), 0), 4) AS totalCostUsd,
              COALESCE(SUM(inputTokens), 0) AS inputTokens,
              COALESCE(SUM(outputTokens), 0) AS outputTokens,
              COALESCE(SUM(cacheReadTokens), 0) AS cacheReadTokens,
              COALESCE(SUM(cacheWriteTokens), 0) AS cacheWriteTokens
       FROM session_costs c
       WHERE c.agentId = ? AND julianday(c.createdAt) > julianday('now', ?)
         ${excludeSelfTaskRows("c")}`,
      [agentId, windowModifier, ...selfParams],
    ),
    query(
      `SELECT soulMd, identityMd, claudeMd, toolsMd, heartbeatMd
       FROM agents WHERE id = ?`,
      [agentId],
    ),
    query(
      `SELECT s.id, s.name, s.description, a.isActive
       FROM agent_skills a JOIN skills s ON s.id = a.skillId
       WHERE a.agentId = ? ORDER BY s.name`,
      [agentId],
    ),
    query(
      `SELECT json_extract(e.data, '$.skillName') AS name, count(*) AS invokes
       FROM events e
       WHERE e.agentId = ? AND e.category = 'skill' AND e.event = 'skill.invoke'
         AND julianday(e.createdAt) > julianday('now', ?)
         ${excludeSelfTaskRows("e")}
       GROUP BY name ORDER BY invokes DESC`,
      [agentId, windowModifier, ...selfParams],
    ),
  ]);

  const profile = profiles[0] ?? {};
  const invocationByName = new Map(invokedSkills.map((row: any) => [row.name, Number(row.invokes) || 0]));
  const taskSummary = {
    total: tasks.length,
    failed: tasks.filter((task: any) => task.status === "failed").length,
    retries: tasks.reduce((total: number, task: any) => total + (Number(task.retryCount) || 0), 0),
    resumes: tasks.filter((task: any) => task.taskType === "resume").length,
  };

  return {
    agentId,
    days,
    generatedAt: new Date().toISOString(),
    tasks: {
      summary: taskSummary,
      recent: tasks.map((task: any) => ({
        id: task.id,
        status: task.status,
        type: task.taskType,
        failureReason: truncate(task.failureReason, 400),
        workflowRunStepId: task.workflowRunStepId,
        retryCount: Number(task.retryCount) || 0,
        createdAt: task.createdAt,
        finishedAt: task.finishedAt,
      })),
    },
    tools: tools.map((tool: any) => ({ tool: tool.tool ?? "unknown", calls: Number(tool.calls) || 0 })),
    memories: memories.map((memory: any) => ({
      id: memory.id,
      name: memory.name,
      scope: memory.scope,
      source: memory.source,
      accessCount: Number(memory.accessCount) || 0,
      usefulness: memory.usefulness == null ? null : Number(memory.usefulness),
      createdAt: memory.createdAt,
    })),
    costContext: costs[0] ?? { sessions: 0, totalCostUsd: 0 },
    profiles: {
      soul: {
        text: truncate(profile.soulMd, 6000),
        h2Anchors: getH2Anchors(String(profile.soulMd ?? "")),
      },
      identity: {
        text: truncate(profile.identityMd, 6000),
        h2Anchors: getH2Anchors(String(profile.identityMd ?? "")),
      },
      claude: {
        text: truncate(profile.claudeMd, 6000),
        h2Anchors: getH2Anchors(String(profile.claudeMd ?? "")),
      },
      tools: {
        text: truncate(profile.toolsMd, 6000),
        h2Anchors: getH2Anchors(String(profile.toolsMd ?? "")),
      },
      heartbeat: {
        text: truncate(profile.heartbeatMd, 6000),
        h2Anchors: getH2Anchors(String(profile.heartbeatMd ?? "")),
      },
    },
    skills: installedSkills.map((skill: any) => ({
      id: skill.id,
      name: skill.name,
      description: truncate(skill.description, 240),
      active: Boolean(skill.isActive),
      invokes: invocationByName.get(skill.name) ?? 0,
    })),
    invokedSkills: invokedSkills.filter((skill: any) => !installedSkills.some((installed: any) => installed.name === skill.name)),
  };
}
