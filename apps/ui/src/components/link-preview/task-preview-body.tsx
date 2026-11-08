/**
 * The task preview's body: the outcome and the card (`task.uiSpec`), as the
 * task page shows them. Loaded lazily by `link-preview-panel.tsx`, as the
 * outcome pulls in the link chips, which import the panel.
 */

import type { AgentTask } from "@/api/types";
import { TaskOutcome } from "@/components/sessions/task-outcome";
import { TaskUiSpecView } from "@/components/shared/task-ui-spec-view";

export function TaskPreviewBody({ task }: { task: AgentTask }) {
  // `TaskOutcome` renders the card under a completed answer; a card with no answer still shows.
  const outcomeHasCard = task.status === "completed" && !!task.output?.trim();
  return (
    <div data-testid="task-preview-body" className="flex min-w-0 flex-col gap-3 p-3">
      <TaskOutcome task={task} />
      {task.uiSpec && !outcomeHasCard ? <TaskUiSpecView task={task} /> : null}
    </div>
  );
}
