/**
 * Run now and the enabled switch for the Overview's schedules (step-10).
 * A paused schedule cannot run now (the route answers 400), so its Run now
 * is `aria-disabled` with the reason in a tooltip. Any server error shows
 * its own message in a toast.
 */

import { type ReactNode, useMemo } from "react";
import { toast } from "sonner";
import { useAgents } from "@/api/hooks/use-agents";
import { useRunScheduleNow, useUpdateSchedule } from "@/api/hooks/use-schedules";
import type { ScheduledTask } from "@/api/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const PAUSED_RUN_REASON = "Turn the schedule on to run it now.";

export type OverviewSchedule = Pick<ScheduledTask, "id" | "name" | "enabled">;

export function useRunNow() {
  const mutation = useRunScheduleNow();
  return {
    /** The schedule whose run is starting, if any. */
    pendingId: mutation.isPending ? (mutation.variables ?? null) : null,
    run: (schedule: OverviewSchedule) => {
      if (!schedule.enabled || mutation.isPending) return;
      mutation.mutate(schedule.id, {
        onSuccess: () => toast.success(`Started a run of ${schedule.name}.`),
        onError: (error) => toast.error(error.message),
      });
    },
  };
}

export function useToggleSchedule() {
  const mutation = useUpdateSchedule();
  return {
    pendingId: mutation.isPending ? (mutation.variables?.id ?? null) : null,
    toggle: (schedule: OverviewSchedule, enabled: boolean) =>
      mutation.mutate(
        { id: schedule.id, data: { enabled } },
        { onError: (error) => toast.error(error.message) },
      ),
  };
}

/** Agent names by id, for the "assignee" of a schedule. */
export function useAgentNames(): (id: string | undefined) => string {
  const { data: agents } = useAgents();
  const names = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );
  return (id) => (id ? (names.get(id) ?? "Unknown agent") : "Task pool");
}

/** A tooltip with the reason a control is blocked. No reason: the control alone. */
export function BlockedHint({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
