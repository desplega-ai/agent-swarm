import { z } from "zod";
import { getH2Anchors } from "../dream-schemas";

export const argsSchema = z.object({
  days: z.number().int().positive().optional().describe("Lookback window in days (default 1)"),
  preflightOnly: z
    .boolean()
    .optional()
    .describe("Stop after the enabled/activity/Lead checks so the workflow can gate rich gathering"),
  selfWorkflowName: z
    .string()
    .optional()
    .describe(
      "Name of the Dreaming workflow whose own task output must not count as swarm activity (default 'dream')",
    ),
});

function payload(response: any): any {
  return response?.data ?? response;
}

function rowsToObjects(response: any): any[] {
  const data = payload(response);
  const columns: string[] = data?.columns ?? [];
  return (data?.rows ?? []).map((row: any) =>
    Array.isArray(row)
      ? Object.fromEntries(columns.map((column, index) => [column, row[index]]))
      : row,
  );
}

function assertSucceeded(response: any, action: string): void {
  if (response?.success === false || payload(response)?.success === false) {
    throw new Error(`${action} failed: ${payload(response)?.error ?? response?.error ?? "unknown error"}`);
  }
}

function configRows(response: any): any[] {
  return payload(response)?.configs ?? [];
}

function scriptResult(response: any): any {
  assertSucceeded(response, "compound-insights");
  const data = payload(response);
  if (data?.exitCode !== undefined && data.exitCode !== 0) {
    throw new Error(`compound-insights exited with code ${data.exitCode}`);
  }
  return data?.result ?? data;
}

function enabledFromConfig(response: any): boolean {
  assertSucceeded(response, "Dreaming enabled config read");
  const row = configRows(response).find((config) => config?.key === "DREAMING_ENABLED");
  if (!row) return true;
  const normalized = String(row.value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  console.warn(
    `DREAMING_ENABLED has invalid boolean value ${JSON.stringify(String(row.value))}; treating it as enabled`,
  );
  return true;
}

function truncate(value: unknown, limit = 6000): string {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function extractProfileEvidence(value: unknown): { excerpt: string; h2Anchors: string[] } {
  const text = String(value ?? "");
  return {
    excerpt: truncate(text, 600),
    h2Anchors: getH2Anchors(text),
  };
}

function slimGatherResult(reason: "disabled" | "no-activity" | "no-lead") {
  return {
    enabled: false,
    hasActivity: false,
    agents: [],
    leadAgentId: null,
    insights: null,
    blockers: [],
    reason,
  };
}

function pullRequestsFromText(text: string): Array<{ repo: string; number: number }> {
  const references: Array<{ repo: string; number: number }> = [];
  const seen = new Set<string>();
  const patterns = [
    /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/g,
    /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const repo = match[1];
      const number = Number(match[2]);
      if (!repo || !Number.isInteger(number) || number < 1) continue;
      const key = `${repo}#${number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ repo, number });
    }
  }
  return references;
}

/** Gather deterministic, swarm-wide inputs for one Dreaming run. */
export default async function dreamGather(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args || {});
  if (!parsed.success) throw new Error(`invalid args: ${parsed.error.message}`);
  const days = parsed.data.days ?? 1;
  const windowModifier = `-${days} days`;
  const selfWorkflowName = parsed.data.selfWorkflowName ?? "dream";

  const enabledResponse = await ctx.swarm.config_get({ key: "DREAMING_ENABLED" });
  if (!enabledFromConfig(enabledResponse)) return slimGatherResult("disabled");

  // The gate must measure activity Dreaming did NOT cause, or it becomes self-sustaining:
  // yesterday's reflection/critique tasks and receipt memory all land inside today's
  // one-day window, so a quiet swarm would keep fanning out forever.
  //   - tasks: every task a dream run creates carries that run's workflowRunId, so the
  //     add-on's whole task output is excluded by joining back to the dream workflow.
  //   - memories: dream's writes are NOT attributable at the row level (inject_learning
  //     stores no provenance) and a receipt memory is written on every run, so counting
  //     memory writes would re-arm the gate unconditionally. Agents write memories while
  //     working tasks, so the task counters already carry that signal.
  const activityResponse = await ctx.swarm.db_query({
    sql: `SELECT
            (SELECT count(*) FROM agent_tasks t
             WHERE t.status = 'completed'
               AND julianday(t.finishedAt) > julianday('now', ?)
               AND (t.workflowRunId IS NULL OR t.workflowRunId NOT IN (
                 SELECT r.id FROM workflow_runs r
                 JOIN workflows w ON w.id = r.workflowId
                 WHERE w.name = ?))) AS completedTasks,
            (SELECT count(*) FROM agent_tasks t
             WHERE t.status = 'failed'
               AND julianday(t.lastUpdatedAt) > julianday('now', ?)
               AND (t.workflowRunId IS NULL OR t.workflowRunId NOT IN (
                 SELECT r.id FROM workflow_runs r
                 JOIN workflows w ON w.id = r.workflowId
                 WHERE w.name = ?))) AS failedTasks`,
    params: [windowModifier, selfWorkflowName, windowModifier, selfWorkflowName],
  });
  assertSucceeded(activityResponse, "Dreaming activity query");
  const activity = rowsToObjects(activityResponse)[0] ?? {};
  const activityCounts = {
    completedTasks: Number(activity.completedTasks) || 0,
    failedTasks: Number(activity.failedTasks) || 0,
  };
  if (!Object.values(activityCounts).some((count) => count > 0)) {
    return slimGatherResult("no-activity");
  }

  const rosterResponse = await ctx.swarm.db_query({
    sql: `SELECT id, name, isLead, status, role,
                 soulMd, identityMd, claudeMd, toolsMd, heartbeatMd
          FROM agents
          WHERE status IN ('idle', 'busy')
          ORDER BY isLead DESC, name ASC, id ASC`,
  });
  assertSucceeded(rosterResponse, "Dreaming roster query");
  const roster = rowsToObjects(rosterResponse);
  const leads = roster.filter((agent) => Boolean(agent.isLead));
  if (leads.length === 0) return slimGatherResult("no-lead");
  const lead = leads[0]!;
  if (leads.length > 1) {
    console.warn(
      `Dreaming found ${leads.length} live Lead agents; using ${String(lead.id)} by roster ordering`,
    );
  }
  const agents = roster.map((agent) => ({ id: String(agent.id), name: String(agent.name) }));
  if (parsed.data.preflightOnly) {
    return {
      enabled: true,
      hasActivity: true,
      agents,
      leadAgentId: String(lead.id),
      insights: null,
      blockers: [],
      reason: "ready",
    };
  }

  const [
    insightsResponse,
    blockersResponse,
    awaitingReplyResponse,
    skillsResponse,
    cursorResponse,
  ] =
    await Promise.all([
      ctx.swarm.script_run({
        name: "compound-insights",
        scope: "global",
        intent: "Dreaming daily gather",
        args: { days, publishPage: false },
      }),
      ctx.swarm.db_query({
        sql: `SELECT id, agentId, status, substr(task, 1, 240) AS task,
                     substr(failureReason, 1, 240) AS failureReason, createdAt, lastUpdatedAt
              FROM agent_tasks
              WHERE (status = 'in_progress'
                     AND julianday(lastUpdatedAt) < julianday('now', '-2 hours'))
                 OR (status = 'failed'
                     AND julianday(lastUpdatedAt) > julianday('now', ?))
              ORDER BY lastUpdatedAt ASC
              LIMIT 50`,
        params: [windowModifier],
      }),
      ctx.swarm.db_query({
        sql: `SELECT id, agentId, substr(task, 1, 240) AS task, createdAt
              FROM agent_tasks
              WHERE slackReplySent = 1
                AND status = 'completed'
                AND requestedByUserId IS NOT NULL
                AND julianday(createdAt) > julianday('now', ?)
              ORDER BY createdAt DESC
              LIMIT 20`,
        params: [windowModifier],
      }),
      ctx.swarm.skill_list({ scope: "swarm" }),
      ctx.swarm.kv_getOrNull({ key: "rotation-cursor", namespace: "dreaming" }),
    ]);

  for (const [response, action] of [
    [blockersResponse, "Dreaming blocker query"],
    [awaitingReplyResponse, "Dreaming awaiting-reply query"],
    [skillsResponse, "Dreaming skill catalog read"],
  ] as const) {
    assertSucceeded(response, action);
  }

  const skills = payload(skillsResponse)?.skills ?? [];
  // kv_getOrNull returns its value directly, unlike tool responses unwrapped by payload().
  const cursor = Number(cursorResponse?.value ?? 0) || 0;
  const profileEvidence = roster.map((agent) => ({
    agentId: String(agent.id),
    agentName: String(agent.name),
    files: {
      SOUL: extractProfileEvidence(agent.soulMd),
      IDENTITY: extractProfileEvidence(agent.identityMd),
      CLAUDE: extractProfileEvidence(agent.claudeMd),
      TOOLS: extractProfileEvidence(agent.toolsMd),
      HEARTBEAT: extractProfileEvidence(agent.heartbeatMd),
    },
  }));
  const heartbeatClaims = roster
    .filter((agent) => String(agent.heartbeatMd ?? "").trim().length > 0)
    .map((agent) => ({
      agentId: String(agent.id),
      agentName: String(agent.name),
      text: truncate(agent.heartbeatMd),
    }));
  const stuckOrFailedTasks = rowsToObjects(blockersResponse);
  const awaitingUserReply = rowsToObjects(awaitingReplyResponse);
  const prReferences = pullRequestsFromText(
    [
      ...heartbeatClaims.map((claim) => claim.text),
      ...stuckOrFailedTasks.flatMap((task) => [String(task.task ?? ""), String(task.failureReason ?? "")]),
    ].join("\n"),
  );
  const rotationTarget = prReferences.length > 0 ? prReferences[cursor % prReferences.length] : null;

  return {
    enabled: true,
    hasActivity: true,
    agents,
    leadAgentId: String(lead.id),
    insights: {
      compound: scriptResult(insightsResponse),
      activity: activityCounts,
      skills,
      profileEvidence,
    },
    blockers: {
      heartbeatClaims,
      stuckOrFailedTasks,
      awaitingUserReply,
      rotation: {
        namespace: "dreaming",
        key: "rotation-cursor",
        cursor,
        target: rotationTarget,
        available: rotationTarget !== null,
        snapshotArgs: rotationTarget
          ? { ...rotationTarget, skipIfMissing: true }
          : { skipIfMissing: true },
      },
    },
  };
}
