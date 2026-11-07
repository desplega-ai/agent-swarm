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
 * Transcript fetches run only for active tasks or expanded history.
 * Steering history loads even when folded, so messages remain visible.
 * A caller that passes its task row skips the task fetch until expansion.
 * Finished tasks do not poll their steering history.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSteeringEnabled } from "@/api/hooks/use-stats";
import { useTask, useTaskSessionLogs, useTaskSteeringMessages } from "@/api/hooks/use-tasks";
import type { AgentTask, AgentTaskStatus } from "@/api/types";
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

/**
 * The live line of an active task that is not running yet. Lifecycle rows
 * ("Created", "Offered") alone never replace it, so a fresh task always says
 * where it stands.
 */
function waitingLabelFor(status: AgentTaskStatus): string {
  switch (status) {
    case "paused":
      return "Paused";
    case "reviewing":
      return "In review";
    case "draft":
      return "Draft. Not queued yet";
    default:
      return "Queued. Waiting for an agent to pick this up…";
  }
}

export interface ChainOfThoughtProps {
  taskId: string;
  status: AgentTaskStatus;
  /** The task row the caller already has (a session chain row): it labels a closed fold. */
  task?: AgentTask;
  className?: string;
}

export function ChainOfThought({ taskId, status, task: known, className }: ChainOfThoughtProps) {
  const isActive = ACTIVE_STATUSES.has(status);
  const [expanded, setExpanded] = useState(false);
  // Poll while the task is active so new activity rows flow in. Stop polling
  // once the task reaches a terminal state. A closed fold over a known row
  // needs no task fetch (an empty id disables the query).
  const { data: fetched } = useTask(known && !isActive && !expanded ? "" : taskId, {
    refetchInterval: isActive ? 4000 : false,
  });
  const task = fetched ?? known;

  // Same gate as everywhere else. Both hooks are react-query-cached globals
  // (`/health` version + `/stats`), so calling them per timeline row costs one
  // shared subscription rather than one request each.
  const steerGate = useFeatureGate("1.122.1");
  const { data: steeringEnabled = true } = useSteeringEnabled();
  const { data: steeringMessages, refetch: refetchSteering } = useTaskSteeringMessages(taskId, {
    enabled: steerGate.supported && steeringEnabled,
    refetchInterval: isActive ? 5000 : false,
  });
  const wasActive = useRef(isActive);
  useEffect(() => {
    // Read the final acknowledgement before the finished task stops polling.
    if (wasActive.current && !isActive && steerGate.supported && steeringEnabled) {
      void refetchSteering();
    }
    wasActive.current = isActive;
  }, [isActive, steerGate.supported, steeringEnabled, refetchSteering]);
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
        logs: fetched?.logs,
        steering: steeringMessages,
        withMessages: false,
      }),
    [sessionLogs, fetched?.logs, steeringMessages],
  );

  if (!isActive && !task) return null;

  // The polled row is fresher than the caller's (a session poll): a queued
  // task flips to "Working for…" as soon as an agent starts it.
  const liveStatus = fetched?.status ?? status;
  const workingSince =
    liveStatus === "in_progress" && task ? (task.acceptedAt ?? task.createdAt) : undefined;

  return (
    <Transcript
      className={className}
      rows={rows}
      running={isActive}
      workingSince={workingSince}
      // A working task shows "Working for …" instead (`workingSince`).
      waitingLabel={
        liveStatus === "in_progress"
          ? workingSince
            ? undefined
            : "Thinking…"
          : waitingLabelFor(liveStatus)
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
