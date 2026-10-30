/**
 * One task's transcript: its prompt as the person's message, the run, then
 * its outcome as the final reply. The task page and the Sessions task sheet
 * both render this, so the two show the same transcript. A finished run folds behind "Worked for …" and
 * keeps the agent's last message in view; a live one follows the bottom of
 * the scroller. Mount it with `key={task.id}` so a new task folds again.
 */

import { type ReactNode, useState } from "react";
import type { AgentTask } from "@/api/types";
import { stripContextFooter } from "@/components/session-panel/model";
import { PromptContext } from "@/components/shared/prompt-context";
import { parsePromptDisplay } from "@/lib/prompt-display";
import { TERMINAL_STATUSES, taskIsRunning } from "@/lib/task-activity";
import { Transcript, TranscriptUserMessage } from "./transcript";
import { type TranscriptRow, workedForLabel } from "./transcript-rows";

export interface TaskTranscriptProps {
  task: Pick<AgentTask, "task" | "status" | "createdAt" | "acceptedAt" | "finishedAt">;
  /** `buildTranscriptRows` over the task's session log and steering. */
  rows: TranscriptRow[];
  /** The surface's scroller (the page column, the sheet body). */
  scroller: HTMLElement | null;
  /** The task's output or failure, after the run. */
  outcome?: ReactNode;
  /** The output's text: see `TranscriptProps.outcomeText`. */
  outcomeText?: string;
}

export function TaskTranscript({
  task,
  rows,
  scroller,
  outcome,
  outcomeText,
}: TaskTranscriptProps) {
  const [runOpen, setRunOpen] = useState(false);
  const prompt = parsePromptDisplay(stripContextFooter(task.task));
  return (
    <Transcript
      rows={rows}
      running={taskIsRunning(task.status) === true}
      outcome={outcome}
      outcomeText={outcomeText}
      prompt={
        <TranscriptUserMessage
          text={prompt.ask}
          header={<PromptContext display={prompt} className={prompt.ask ? "mb-2" : undefined} />}
        />
      }
      fold={
        TERMINAL_STATUSES.has(task.status) && rows.length > 0
          ? {
              label: workedForLabel(task.acceptedAt ?? task.createdAt, task.finishedAt),
              open: runOpen,
              onOpenChange: setRunOpen,
            }
          : null
      }
      workingSince={task.status === "in_progress" ? (task.acceptedAt ?? task.createdAt) : undefined}
      scroller={scroller}
    />
  );
}
