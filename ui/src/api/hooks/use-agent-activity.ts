import { useMemo } from "react";
import type { AgentWithTasks } from "@/api/types";
import { useAgents } from "./use-agents";
import { useUsageSummary } from "./use-costs";
import { useTasks } from "./use-tasks";

/**
 * Per-agent 24h activity rollup (Phase 5 ≥1.76.0).
 *
 * Sources:
 *   - `useAgents()` — agent roster (used by both canvas and table).
 *   - `useTasks({ createdAfter, limit })` — bounded fetch of tasks created in
 *     the last `windowHours` window. The server-side `createdAfter` filter
 *     ships in Phase 2; we count rows by `agentId`.
 *   - `useUsageSummary({ groupBy: "agent", startDate })` — server-side per-agent
 *     cost rollup. `useDashboardCosts()` only exposes swarm-wide aggregates
 *     (`costToday` / `costMtd`); the per-agent breakdown lives on the
 *     `/api/session-costs/summary?groupBy=agent` endpoint, so we use that.
 *
 * The hook returns a stable list of agents (one row per agent in the roster)
 * with `taskCount24h` / `cost24h` zero-filled for agents with no activity.
 */

export interface AgentActivityRow {
  agent: AgentWithTasks;
  taskCount24h: number;
  cost24h: number;
}

export interface UseAgentActivityOptions {
  /** Lookback window in hours. Defaults to 24. */
  windowHours?: number;
  /** Bound on the task fetch. Defaults to 1000 (≥ a busy day's worth). */
  taskLimit?: number;
}

export interface UseAgentActivityResult {
  agents: AgentActivityRow[];
  /**
   * True when the bounded fetch hit the limit; consumers should warn the
   * user that the activity counts may be capped.
   */
  truncated: boolean;
  isLoading: boolean;
  isError: boolean;
}

export function useAgentActivity(opts: UseAgentActivityOptions = {}): UseAgentActivityResult {
  const windowHours = opts.windowHours ?? 24;
  const taskLimit = opts.taskLimit ?? 1000;

  // ISO timestamp for `windowHours` ago. Memoized to a 1-minute granularity so
  // the query key doesn't churn every render.
  const sinceIso = useMemo(() => {
    const ms = Date.now() - windowHours * 60 * 60 * 1000;
    // Round to the minute to keep the query key stable across re-renders.
    const minute = Math.floor(ms / 60_000) * 60_000;
    return new Date(minute).toISOString();
  }, [windowHours]);

  const agentsQ = useAgents();
  const tasksQ = useTasks({ createdAfter: sinceIso, limit: taskLimit });
  const usageQ = useUsageSummary({ groupBy: "agent", startDate: sinceIso });

  return useMemo(() => {
    const agents = (agentsQ.data ?? []) as AgentWithTasks[];
    const tasks = tasksQ.data?.tasks ?? [];
    const total = tasksQ.data?.total ?? tasks.length;
    const byAgent = usageQ.data?.byAgent ?? [];

    // Aggregate task count per agent.
    const taskCounts = new Map<string, number>();
    for (const t of tasks) {
      if (!t.agentId) continue;
      taskCounts.set(t.agentId, (taskCounts.get(t.agentId) ?? 0) + 1);
    }

    // Build cost-by-agent index.
    const costs = new Map<string, number>();
    for (const row of byAgent) {
      costs.set(row.agentId, row.costUsd);
    }

    const rows: AgentActivityRow[] = agents.map((agent) => ({
      agent,
      taskCount24h: taskCounts.get(agent.id) ?? 0,
      cost24h: costs.get(agent.id) ?? 0,
    }));

    return {
      agents: rows,
      truncated: total > taskLimit,
      isLoading: agentsQ.isLoading || tasksQ.isLoading || usageQ.isLoading,
      isError: agentsQ.isError || tasksQ.isError || usageQ.isError,
    };
  }, [
    agentsQ.data,
    agentsQ.isLoading,
    agentsQ.isError,
    tasksQ.data,
    tasksQ.isLoading,
    tasksQ.isError,
    usageQ.data,
    usageQ.isLoading,
    usageQ.isError,
    taskLimit,
  ]);
}

// --- Activity-score normalization (canvas node sizing) --------------------
//
// Starting heuristic per the plan (tune in v1.1):
//   score = 0.6 * normalize(taskCount24h) + 0.4 * normalize(cost24h)
//   size  = MIN_SIZE + (MAX_SIZE - MIN_SIZE) * score
//
// If both dimensions are zero across the swarm, fall back to constant MIN_SIZE
// (no normalization on a zero vector).

export const MIN_NODE_WIDTH = 200;
export const MAX_NODE_WIDTH = 360;
// Min height must fit the node's fixed content (icon/name row + role pill +
// stats line) under `box-sizing: border-box` with a 2px border + py-2 padding.
// 80px clipped the stats line; 104px contains it at the smallest size.
export const MIN_NODE_HEIGHT = 104;
export const MAX_NODE_HEIGHT = 152;

const TASK_WEIGHT = 0.6;
const COST_WEIGHT = 0.4;

/**
 * Compute a 0..1 activity score per agent given the swarm's max in each
 * dimension. Returns 0 when the swarm has zero activity in both dimensions.
 */
export function computeActivityScores(rows: AgentActivityRow[]): Map<string, number> {
  const maxTasks = rows.reduce((m, r) => Math.max(m, r.taskCount24h), 0);
  const maxCost = rows.reduce((m, r) => Math.max(m, r.cost24h), 0);

  const scores = new Map<string, number>();
  if (maxTasks === 0 && maxCost === 0) {
    for (const r of rows) scores.set(r.agent.id, 0);
    return scores;
  }

  for (const r of rows) {
    const tNorm = maxTasks > 0 ? r.taskCount24h / maxTasks : 0;
    const cNorm = maxCost > 0 ? r.cost24h / maxCost : 0;
    scores.set(r.agent.id, TASK_WEIGHT * tNorm + COST_WEIGHT * cNorm);
  }
  return scores;
}

export function nodeSizeFromScore(score: number): { width: number; height: number } {
  const clamped = Math.max(0, Math.min(1, score));
  return {
    width: MIN_NODE_WIDTH + (MAX_NODE_WIDTH - MIN_NODE_WIDTH) * clamped,
    height: MIN_NODE_HEIGHT + (MAX_NODE_HEIGHT - MIN_NODE_HEIGHT) * clamped,
  };
}
