import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../client";
import type { SavingsTarget, SavingsTier } from "../types";

/** Savings come from an hourly rollup; 10 minutes is fresh enough. */
const STALE_MS = 10 * 60 * 1000;

/** Saving of one workflow or script over the last 30 days. */
export function useJobSavings(target: SavingsTarget | undefined) {
  return useQuery({
    queryKey: ["savings", "job", target],
    queryFn: () => api.getSavingsJobs(target as SavingsTarget),
    enabled: !!target,
    staleTime: STALE_MS,
    retry: false,
  });
}

/** One workflow's saving with its components (child runs, nested scripts, tasks), for the Savings tab toggle. */
export function useWorkflowSavingsComponents(workflowId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["savings", "components", workflowId],
    queryFn: () => api.getSavingsJobs({ workflowId }, { components: true }),
    enabled,
    staleTime: STALE_MS,
    retry: false,
  });
}

export function useJobSavingsDaily(target: SavingsTarget | undefined, enabled = true) {
  return useQuery({
    queryKey: ["savings", "job-daily", target],
    queryFn: () => api.getSavingsDaily(target as SavingsTarget),
    enabled: !!target && enabled,
    staleTime: STALE_MS,
    retry: false,
  });
}

/** Saving of every workflow over the last 30 days, for the workflows list. */
export function useWorkflowsSavings() {
  return useQuery({
    queryKey: ["savings", "workflows"],
    queryFn: () => api.getSavingsJobs({ kind: "workflow" }, { days: 30 }),
    staleTime: STALE_MS,
    retry: false,
  });
}

/** Saving of every script name over the last 30 days, for the scripts list. */
export function useScriptsSavings() {
  return useQuery({
    queryKey: ["savings", "scripts"],
    queryFn: () => api.getSavingsJobs({ kind: "script" }, { days: 30 }),
    staleTime: STALE_MS,
    retry: false,
  });
}

export type SavingsWindow = { days: 7 | 30 | 90; tier: SavingsTier };

/** The fleet page: summary, daily series, and every workflow and script, for one window and tier. */
export function useFleetSavings(window: SavingsWindow) {
  const opts = { staleTime: STALE_MS, retry: false, placeholderData: keepPreviousData } as const;
  const summary = useQuery({
    queryKey: ["savings", "fleet", window],
    queryFn: () => api.getSavingsSummary(window),
    ...opts,
  });
  const daily = useQuery({
    queryKey: ["savings", "fleet-daily", window],
    queryFn: () => api.getSavingsDaily(undefined, window),
    ...opts,
  });
  const workflows = useQuery({
    queryKey: ["savings", "workflows", window],
    queryFn: () => api.getSavingsJobs({ kind: "workflow" }, window),
    ...opts,
  });
  const scripts = useQuery({
    queryKey: ["savings", "scripts", window],
    queryFn: () => api.getSavingsJobs({ kind: "script" }, window),
    ...opts,
  });
  return { summary, daily, workflows, scripts };
}

/** Saving of one schedule over the last 30 days. */
export function useScheduleSavings(scheduleId: string | undefined) {
  return useQuery({
    queryKey: ["savings", "schedule", scheduleId],
    queryFn: () => api.getSavingsSchedules({ scheduleId: scheduleId as string }, { days: 30 }),
    enabled: !!scheduleId,
    staleTime: STALE_MS,
    retry: false,
  });
}

/** Saving of every schedule over the last 30 days, for the schedules list. */
export function useSchedulesSavings() {
  return useQuery({
    queryKey: ["savings", "schedules"],
    queryFn: () => api.getSavingsSchedules({ kind: "schedule" }, { days: 30 }),
    staleTime: STALE_MS,
    retry: false,
  });
}

/**
 * Home's savings at the page's default tier: the 30-day fleet summary (the
 * same cache entry as /usage/savings) and the last 7 days, for today's point.
 */
export function useHomeSavings() {
  const opts = { staleTime: STALE_MS, retry: false } as const;
  const window30: SavingsWindow = { days: 30, tier: "smart" };
  const window7: SavingsWindow = { days: 7, tier: "smart" };
  const summary = useQuery({
    queryKey: ["savings", "fleet", window30],
    queryFn: () => api.getSavingsSummary(window30),
    ...opts,
  });
  const daily = useQuery({
    queryKey: ["savings", "fleet-daily", window7],
    queryFn: () => api.getSavingsDaily(undefined, window7),
    ...opts,
  });
  return { summary, daily };
}
