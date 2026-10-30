/**
 * Chain-of-thought indicator: one agent turn's activity inline in the
 * Sessions timeline, rendered by the shared <Transcript> (work only, no
 * prose: the turn's answer is its own row in the timeline).
 *
 * Merges three sources into one chronological list:
 *   - the canonical `AgentLog[]` activity stream via `useTask(id)`,
 *   - the main agent's tool calls and reasoning, parsed from the session
 *     transcript (`useTaskSessionLogs`). Sub-agent steps stay in the detail
 *     sheet's transcript,
 *   - steering messages (≥1.122.1), rendered as a distinct user-injected line.
 *
 * Visible states:
 *   - active (`pending` / `offered` / `in_progress`): always rendered, the
 *     newest step shimmers. While the task is active the queries poll (4 s
 *     activity, 5 s transcript and steering) so new steps flow in live.
 *   - terminal (`completed` / `failed` / `cancelled` / `superseded`): one
 *     "Worked for 3m 12s" line, collapsed by default, that expands on click.
 *
 * Polling cost is deliberately bounded: the transcript and steering fetches
 * are enabled only for tasks that are still active, or terminal tasks the
 * user has explicitly expanded — a long session's historical rows never fire
 * a request.
 */

import { useMemo, useState } from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSteeringEnabled } from "@/api/hooks/use-stats";
import { useTask, useTaskSessionLogs, useTaskSteeringMessages } from "@/api/hooks/use-tasks";
import type { AgentTaskStatus } from "@/api/types";
import { Transcript } from "@/components/shared/transcript/transcript";
import {
  buildTranscriptRows,
  workedForLabel,
} from "@/components/shared/transcript/transcript-rows";
import { parseSessionLogs } from "@/logs-parser";

const ACTIVE_STATUSES = new Set<AgentTaskStatus>([
  "pending",
  "offered",
  "backlog",
  "unassigned",
  "draft",
  "in_progress",
  "paused",
  "reviewing",
]);

export interface ChainOfThoughtProps {
  taskId: string;
  status: AgentTaskStatus;
  className?: string;
}

export function ChainOfThought({ taskId, status, className }: ChainOfThoughtProps) {
  const isActive = ACTIVE_STATUSES.has(status);
  // Poll while the task is active so new activity rows flow in. Stop polling
  // once the task reaches a terminal state.
  const { data: task } = useTask(taskId, { refetchInterval: isActive ? 4000 : false });

  const [expanded, setExpanded] = useState(false);

  // Same gate as everywhere else. Both hooks are react-query-cached globals
  // (`/health` version + `/stats`), so calling them per timeline row costs one
  // shared subscription rather than one request each.
  const steerGate = useFeatureGate("1.122.1");
  const { data: steeringEnabled = true } = useSteeringEnabled();
  const { data: steeringMessages } = useTaskSteeringMessages(taskId, {
    enabled: steerGate.supported && steeringEnabled && (isActive || expanded),
    refetchInterval: isActive ? 5000 : false,
  });
  // Shares the detail sheet's query key, so opening the sheet reuses it. A
  // disabled query still returns the cached transcript, so a turn watched
  // live keeps its steps once it ends.
  const { data: sessionLogs } = useTaskSessionLogs(taskId, {
    enabled: isActive || expanded,
    refetchInterval: isActive ? 5000 : false,
  });
  const rows = useMemo(
    () =>
      buildTranscriptRows({
        messages: parseSessionLogs(sessionLogs ?? []),
        logs: task?.logs,
        steering: steeringMessages,
        withMessages: false,
      }),
    [sessionLogs, task?.logs, steeringMessages],
  );

  if (!isActive && !task) return null;

  return (
    <Transcript
      className={className}
      rows={rows}
      running={isActive}
      waitingLabel={
        status === "in_progress" ? "Thinking…" : "Waiting for an agent to pick this up…"
      }
      fold={
        task
          ? {
              label: workedForLabel(task.acceptedAt ?? task.createdAt, task.finishedAt),
              open: expanded,
              onOpenChange: setExpanded,
            }
          : null
      }
    />
  );
}
