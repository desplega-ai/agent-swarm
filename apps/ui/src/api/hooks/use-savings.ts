import { useQuery } from "@tanstack/react-query";
import { api } from "../client";
import type { SavingsTarget } from "../types";

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
