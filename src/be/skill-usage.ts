import { getStorage } from "./storage";

/**
 * Read-only skill usage analytics over `skill_invocations` (written by
 * src/be/skill-invocations.ts). Every aggregate runs in SQL; callers get
 * small, already-grouped rows.
 *
 * Windows are rolling (`7d` = the last 7 x 24 h). Daily buckets shift each
 * row by `tzOffsetMinutes` first, so a day is the viewer's local day.
 */

export const SKILL_USAGE_WINDOWS = ["7d", "30d", "all"] as const;
export type SkillUsageWindow = (typeof SKILL_USAGE_WINDOWS)[number];

const WINDOW_DAYS: Record<SkillUsageWindow, number | null> = { "7d": 7, "30d": 30, all: null };
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 25;

/** The `all` summary scans the whole history, so it is reused for a while. */
const ALL_WINDOW_CACHE_MS = 5 * 60 * 1000;
const allWindowCache = new Map<number, { at: number; summary: Promise<SkillUsageSummary> }>();

export function skillUsageWindowStart(window: SkillUsageWindow, now = Date.now()): string | null {
  const days = WINDOW_DAYS[window];
  return days === null ? null : new Date(now - days * DAY_MS).toISOString();
}

export interface SkillUsageDailyRow {
  date: string;
  invocations: number;
  skills: number;
  tasks: number;
}

export interface SkillUsageCountRow {
  key: string;
  invocations: number;
}

export interface SkillUsageBySkillRow {
  skillId: string | null;
  skillName: string;
  invocations: number;
  agents: number;
  tokens: number;
  lastInvokedAt: string;
}

export interface SkillUsageAgentRow {
  agentId: string;
  agentName: string;
  isLead: boolean;
  installed: number;
  installedUsed: number;
  skillsUsed: number;
  invocations: number;
  lastInvokedAt: string | null;
}

export interface SkillUsageUnusedRow {
  id: string;
  name: string;
  scope: string;
  type: string;
  systemDefault: boolean;
  /** True when every agent gets it (system default or swarm scope). */
  installedEverywhere: boolean;
  /** Agents with an explicit active install. */
  installedAgents: number;
  invocationCount: number;
  lastInvokedAt: string | null;
}

export interface SkillUsageSummary {
  window: SkillUsageWindow;
  since: string | null;
  /** First recorded invocation, swarm-wide. Older activity was never recorded. */
  trackingSince: string | null;
  generatedAt: string;
  totals: {
    invocations: number;
    distinctSkills: number;
    distinctAgents: number;
    distinctTasks: number;
    /** Invocations of a name that resolves to no `skills` row. */
    unresolved: number;
    tokens: number;
  };
  taskAdoption: { tasks: number; tasksWithSkill: number; since: string | null };
  daily: SkillUsageDailyRow[];
  byHarness: SkillUsageCountRow[];
  bySkill: SkillUsageBySkillRow[];
  agents: SkillUsageAgentRow[];
  unused: SkillUsageUnusedRow[];
}

export interface SkillUsageRecentRow {
  id: string;
  agentId: string | null;
  agentName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  harness: string | null;
  via: string | null;
  skillVersion: number | null;
  tokenCount: number | null;
  createdAt: string;
}

export interface SkillUsageDetail {
  skillId: string;
  window: SkillUsageWindow;
  since: string | null;
  generatedAt: string;
  totals: { invocations: number; distinctAgents: number; distinctTasks: number; tokens: number };
  daily: SkillUsageDailyRow[];
  byAgent: {
    agentId: string;
    agentName: string | null;
    invocations: number;
    lastInvokedAt: string;
  }[];
  byHarness: SkillUsageCountRow[];
  byVia: SkillUsageCountRow[];
  recent: SkillUsageRecentRow[];
}

export function getSkillUsageSummary(
  window: SkillUsageWindow,
  tzOffsetMinutes = 0,
  now = Date.now(),
): Promise<SkillUsageSummary> {
  if (window !== "all") return computeSkillUsageSummary(window, tzOffsetMinutes, now);

  const cached = allWindowCache.get(tzOffsetMinutes);
  if (cached && now >= cached.at && now - cached.at < ALL_WINDOW_CACHE_MS) return cached.summary;
  for (const [key, entry] of allWindowCache) {
    if (now - entry.at >= ALL_WINDOW_CACHE_MS) allWindowCache.delete(key);
  }
  const summary = computeSkillUsageSummary(window, tzOffsetMinutes, now);
  allWindowCache.set(tzOffsetMinutes, { at: now, summary });
  summary.catch(() => {
    if (allWindowCache.get(tzOffsetMinutes)?.summary === summary) {
      allWindowCache.delete(tzOffsetMinutes);
    }
  });
  return summary;
}

async function computeSkillUsageSummary(
  window: SkillUsageWindow,
  tzOffsetMinutes: number,
  now: number,
): Promise<SkillUsageSummary> {
  const skills = getStorage().repos.skills;
  const since = skillUsageWindowStart(window, now);

  const totals = await skills.usageTotals(since);
  const trackingSince = await skills.firstInvocationAt();
  const daily = await skills.usageDaily(since, tzOffsetMinutes);
  const byHarness = await skills.usageByHarness(since);
  const bySkill = await skills.usageBySkill(since);

  // Task adoption counts only tasks created after tracking began, so a window
  // reaching past the first recorded invocation is not deflated by tasks that
  // could never have recorded one.
  const adoptionSince =
    trackingSince === null ? null : since !== null && since > trackingSince ? since : trackingSince;
  const adoption =
    adoptionSince === null
      ? { tasks: 0, tasksWithSkill: 0 }
      : await skills.taskAdoption(adoptionSince);

  // Installed = what getAgentSkills returns: active explicit installs plus
  // every enabled system-default or swarm-scope skill, deduplicated by name.
  // Agents that are offline and used nothing in the window are left out.
  const agentRows = await skills.usageByAgent(since);
  const unusedRows = await skills.unusedSkills(since);

  return {
    window,
    since,
    trackingSince,
    generatedAt: new Date(now).toISOString(),
    totals: {
      invocations: totals?.invocations ?? 0,
      distinctSkills: totals?.distinctSkills ?? 0,
      distinctAgents: totals?.distinctAgents ?? 0,
      distinctTasks: totals?.distinctTasks ?? 0,
      unresolved: totals?.unresolved ?? 0,
      tokens: totals?.tokens ?? 0,
    },
    taskAdoption: {
      tasks: adoption?.tasks ?? 0,
      tasksWithSkill: adoption?.tasksWithSkill ?? 0,
      since: adoptionSince,
    },
    daily,
    byHarness,
    bySkill,
    agents: agentRows.map((row) => ({ ...row, isLead: row.isLead === 1 })),
    unused: unusedRows.map((row) => ({
      ...row,
      systemDefault: row.systemDefault === 1,
      installedEverywhere: row.installedEverywhere === 1,
    })),
  };
}

export async function getSkillUsageDetail(
  skillId: string,
  window: SkillUsageWindow,
  tzOffsetMinutes = 0,
  now = Date.now(),
): Promise<SkillUsageDetail> {
  const skills = getStorage().repos.skills;
  const since = skillUsageWindowStart(window, now);

  const totals = await skills.detailTotals(skillId, since);
  const daily = await skills.detailDaily(skillId, since, tzOffsetMinutes);
  const byAgent = await skills.detailByAgent(skillId, since);
  const byHarness = await skills.detailCountBy(skillId, since, "harness");
  const byVia = await skills.detailCountBy(skillId, since, "via");
  const recent = await skills.detailRecent(skillId, since, RECENT_LIMIT);

  return {
    skillId,
    window,
    since,
    generatedAt: new Date(now).toISOString(),
    totals: {
      invocations: totals?.invocations ?? 0,
      distinctAgents: totals?.distinctAgents ?? 0,
      distinctTasks: totals?.distinctTasks ?? 0,
      tokens: totals?.tokens ?? 0,
    },
    daily,
    byAgent,
    byHarness,
    byVia,
    recent,
  };
}
