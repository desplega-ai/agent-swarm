import type { WorkflowRunStepStatus } from "@/api/types";

export const statusBorderColor: Record<WorkflowRunStepStatus, string> = {
  pending: "border-status-neutral/50",
  running: "border-status-active",
  waiting: "border-status-pending",
  completed: "border-status-success",
  failed: "border-status-error",
  skipped: "border-status-neutral/40",
};
