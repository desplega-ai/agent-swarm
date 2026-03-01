import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../client";
import type { SessionCost, UsageStats } from "../types";

export interface SessionCostFilters {
  agentId?: string;
  taskId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  enabled?: boolean;
}

export function useSessionCosts(filters?: SessionCostFilters) {
  return useQuery({
    queryKey: ["session-costs", filters],
    queryFn: () => api.fetchSessionCosts(filters),
    select: (data) => data.costs,
    enabled: filters?.enabled !== false,
  });
}

function aggregateUsage(costs: SessionCost[]): UsageStats {
  return {
    totalCostUsd: costs.reduce((sum, c) => sum + c.totalCostUsd, 0),
    totalTokens: costs.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0),
    inputTokens: costs.reduce((sum, c) => sum + c.inputTokens, 0),
    outputTokens: costs.reduce((sum, c) => sum + c.outputTokens, 0),
    cacheReadTokens: costs.reduce((sum, c) => sum + c.cacheReadTokens, 0),
    cacheWriteTokens: costs.reduce((sum, c) => sum + c.cacheWriteTokens, 0),
    sessionCount: costs.length,
    totalDurationMs: costs.reduce((sum, c) => sum + c.durationMs, 0),
    avgCostPerSession:
      costs.length > 0 ? costs.reduce((sum, c) => sum + c.totalCostUsd, 0) / costs.length : 0,
  };
}

export function useMonthlyUsageStats() {
  const { data: costs, ...rest } = useSessionCosts({ limit: 1000 });

  const stats = useMemo(() => {
    if (!costs) return null;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyCosts = costs.filter((c) => new Date(c.createdAt) >= startOfMonth);

    return {
      totalCostUsd: monthlyCosts.reduce((sum, c) => sum + c.totalCostUsd, 0),
      totalTokens: monthlyCosts.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0),
      inputTokens: monthlyCosts.reduce((sum, c) => sum + c.inputTokens, 0),
      outputTokens: monthlyCosts.reduce((sum, c) => sum + c.outputTokens, 0),
      cacheReadTokens: monthlyCosts.reduce((sum, c) => sum + c.cacheReadTokens, 0),
      cacheWriteTokens: monthlyCosts.reduce((sum, c) => sum + c.cacheWriteTokens, 0),
      sessionCount: monthlyCosts.length,
      totalDurationMs: monthlyCosts.reduce((sum, c) => sum + c.durationMs, 0),
      avgCostPerSession:
        monthlyCosts.length > 0
          ? monthlyCosts.reduce((sum, c) => sum + c.totalCostUsd, 0) / monthlyCosts.length
          : 0,
    };
  }, [costs]);

  return { data: stats, ...rest };
}

export function useAgentUsageSummary(agentId: string) {
  return useQuery({
    queryKey: ["agent-usage", agentId],
    queryFn: () => api.fetchSessionCosts({ agentId, limit: 500 }),
    select: (data) => {
      const costs = data.costs;
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const filterByDate = (start: Date) => costs.filter((c) => new Date(c.createdAt) >= start);

      return {
        daily: aggregateUsage(filterByDate(startOfDay)),
        weekly: aggregateUsage(filterByDate(startOfWeek)),
        monthly: aggregateUsage(filterByDate(startOfMonth)),
        all: aggregateUsage(costs),
      };
    },
    enabled: !!agentId,
  });
}

export function useTaskUsage(taskId: string) {
  return useQuery({
    queryKey: ["task-usage", taskId],
    queryFn: () => api.fetchSessionCosts({ taskId }),
    select: (data) => aggregateUsage(data.costs),
    enabled: !!taskId,
  });
}

// --- New hooks using server-side aggregation ---

export function useUsageSummary(filters?: {
  startDate?: string;
  endDate?: string;
  agentId?: string;
  groupBy?: "day" | "agent" | "both";
}) {
  return useQuery({
    queryKey: ["usage-summary", filters],
    queryFn: () => api.fetchUsageSummary(filters),
  });
}

export function useDashboardCosts() {
  return useQuery({
    queryKey: ["dashboard-costs"],
    queryFn: () => api.fetchDashboardCosts(),
  });
}
