import { renderTaskCitations } from "../../../../../src/utils/task-citations";
/**
 * Sessions surface (Phase 4 ≥1.76.0) — task-detail Sheet, opened from a
 * timeline `<TaskCard>` click.
 *
 * Wraps shadcn `<Sheet side="right">`. The transcript is the task page's
 * `<TaskTranscript>`, so the sheet and the page show the same run, with the
 * outcome as its last message.
 */

import { ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { useSessionCosts } from "@/api/hooks/use-costs";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSteeringEnabled } from "@/api/hooks/use-stats";
import { useTaskSessionLogs, useTaskSteeringMessages } from "@/api/hooks/use-tasks";
import type { AgentTask } from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { JsonTree } from "@/components/shared/json-tree";
import { ShowMore } from "@/components/shared/show-more";
import { StatusBadge } from "@/components/shared/status-badge";
import { TaskAttachmentsSection } from "@/components/shared/task-attachments-section";
import { TaskTranscript } from "@/components/shared/transcript/task-transcript";
import { buildTranscriptRows } from "@/components/shared/transcript/transcript-rows";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { parseJsonOutput } from "@/lib/json-output";
import { taskListTitle } from "@/lib/task-title";
import { normalizeNewlines } from "@/lib/utils";
import { parseSessionLogs } from "@/logs-parser";

export interface TaskDetailSheetProps {
  taskId: string;
  /** Optional — pass the task object we already have so the header renders without a re-fetch. */
  task?: AgentTask;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

export function TaskDetailSheet({ taskId, task, open, onOpenChange }: TaskDetailSheetProps) {
  // Only fetch once the sheet opens — keeps idle session-list pages cheap.
  const { data: logs, isLoading: logsLoading } = useTaskSessionLogs(open ? taskId : "");
  // The same steering gate and rows as the task page.
  const steerGate = useFeatureGate("1.122.1");
  const { data: steeringEnabled = true } = useSteeringEnabled();
  const { data: steering } = useTaskSteeringMessages(taskId, {
    enabled: open && steerGate.supported && steeringEnabled,
  });
  const rows = useMemo(
    () => buildTranscriptRows({ messages: parseSessionLogs(logs ?? []), steering }),
    [logs, steering],
  );
  // The body is the sheet's one scroller: a live run follows its bottom.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const { data: costs, isLoading: costsLoading } = useSessionCosts({
    taskId,
    enabled: open,
  });

  const totalCost = costs?.reduce((sum, c) => sum + c.totalCostUsd, 0) ?? 0;
  const totalSessions = costs?.length ?? 0;
  const outputJson = task?.status === "completed" ? parseJsonOutput(task.output) : null;
  const output = task?.status === "completed" ? task.output?.trim() : undefined;
  const failure =
    task && (task.status === "failed" || task.status === "cancelled")
      ? task.failureReason?.trim()
      : undefined;
  // The outcome, the transcript's last message: the answer as plain text, or
  // the error in the error color, clamped with "Show more".
  const outcome = output ? (
    <div data-slot="transcript-outcome" className="min-w-0 px-1">
      {outputJson ? (
        <JsonTree data={outputJson} defaultExpandDepth={2} maxHeight="60vh" copyable />
      ) : (
        <ShowMore>
          <div className="text-sm leading-relaxed text-foreground/90 min-w-0 break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full">
            <Streamdown>
              {renderTaskCitations(normalizeNewlines(output), task?.citations ?? [], "markdown")}
            </Streamdown>
          </div>
        </ShowMore>
      )}
    </div>
  ) : failure ? (
    <div data-slot="transcript-outcome" className="min-w-0 px-1">
      <p className="text-xs font-medium text-status-error-strong">
        {task?.status === "cancelled" ? "Cancelled" : "Failed"}
      </p>
      <ShowMore>
        <div className="text-sm leading-relaxed text-status-error-strong min-w-0 break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full">
          <Streamdown>{normalizeNewlines(failure)}</Streamdown>
        </div>
      </ShowMore>
    </div>
  ) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl flex flex-col gap-0 p-0 overflow-hidden"
      >
        {/* Header — title + meta row (status, agent link, costs). Whole sheet
            is locked: only the transcript section scrolls. */}
        <SheetHeader className="border-b border-border pl-4 pr-12 py-3 shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <SheetTitle className="text-sm font-medium truncate min-w-0">
                {task ? taskListTitle(task) : `Task ${taskId.slice(0, 8)}…`}
              </SheetTitle>
              <SheetDescription className="text-xs font-mono text-muted-foreground truncate">
                {taskId}
              </SheetDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {task ? <StatusBadge status={task.status} /> : null}
              <Button asChild variant="ghost" size="icon" className="h-7 w-7">
                <Link
                  to={`/tasks/${taskId}`}
                  aria-label="Open task detail page"
                  title="Open task detail page"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </div>
        </SheetHeader>

        {/* Meta row — agent + cost summary above the transcript. */}
        <div className="border-b border-border px-4 py-2 flex items-center gap-3 text-xs text-muted-foreground shrink-0 flex-wrap">
          {task?.agentId ? (
            <span className="flex items-center gap-1.5">
              <span className="uppercase tracking-wider text-[9px]">Agent</span>
              <AgentLink agentId={task.agentId} />
            </span>
          ) : (
            <span className="font-mono text-[11px]">Unassigned</span>
          )}
          <span aria-hidden="true">·</span>
          <span className="flex items-center gap-1.5">
            <span className="uppercase tracking-wider text-[9px]">Cost</span>
            {costsLoading ? (
              <Skeleton className="h-3 w-12" />
            ) : (
              <span className="font-mono">{usdFormatter.format(totalCost)}</span>
            )}
          </span>
          <span aria-hidden="true">·</span>
          <span className="flex items-center gap-1.5">
            <span className="uppercase tracking-wider text-[9px]">Sessions</span>
            <span className="font-mono">{totalSessions}</span>
          </span>
        </div>

        {/* Body: the one scroller. Attachments, then the transcript, whose
            last message is the outcome. */}
        <div ref={setBody} className="flex-1 min-h-0 overflow-auto">
          {open ? (
            <TaskAttachmentsSection taskId={taskId} attachments={undefined} className="mx-4 my-3" />
          ) : null}

          <section className="px-4 py-3 flex flex-col gap-2">
            <h4 className="font-mono font-bold text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              Transcript
            </h4>
            {task ? (
              <TaskTranscript
                key={task.id}
                task={task}
                rows={rows}
                scroller={body}
                outcome={rows.length > 0 ? outcome : null}
                outcomeText={output}
              />
            ) : null}
            {rows.length > 0 ? null : logsLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <p className="text-xs text-muted-foreground italic">No transcript yet.</p>
            )}
            {rows.length > 0 ? null : outcome}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
