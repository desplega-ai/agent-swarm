/**
 * Sessions surface — chat-style bubble for a user-initiated message.
 *
 * Used for both the session root prompt and any follow-up tasks created via
 * the composer (i.e. tasks with `requestedByUserId` set). The bubble is
 * right-aligned with left-aligned text inside, capped at a sensible
 * max-width so long prompts read like a real chat message instead of
 * cascading down the page as a giant right-aligned block.
 */

import { useUsers } from "@/api/hooks/use-users";
import type { TaskAttachment } from "@/api/types";
import { TaskPromptAttachments } from "@/components/shared/task-attachments-section";
import { cn } from "@/lib/utils";

export interface UserPromptBubbleProps {
  text: string;
  /** Look up the requester's display name from the users cache. */
  requestedByUserId: string | null | undefined;
  createdAt: string;
  taskId?: string;
  attachments?: TaskAttachment[];
  className?: string;
}

export function UserPromptBubble({
  text,
  requestedByUserId,
  createdAt,
  taskId,
  attachments,
  className,
}: UserPromptBubbleProps) {
  const { data: users } = useUsers();
  const requesterName =
    (requestedByUserId && users?.find((u) => u.id === requestedByUserId)?.name) || "User";
  const date = new Date(createdAt);
  const dateLabel = date.toLocaleString();
  return (
    <section
      aria-label="User message"
      className={cn("flex justify-end pl-10 pb-3 min-w-0", className)}
    >
      <div className="flex flex-col gap-1 items-end max-w-[85%] min-w-0">
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground px-1">
          <span>{requesterName}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={createdAt}>{dateLabel}</time>
        </div>
        {taskId ? <TaskPromptAttachments taskId={taskId} attachments={attachments} /> : null}
        <div
          className={cn(
            "rounded-2xl rounded-tr-sm bg-muted px-4 py-2.5",
            "text-sm leading-relaxed text-foreground/95",
            "whitespace-pre-wrap break-words text-left min-w-0",
          )}
        >
          {text}
        </div>
      </div>
    </section>
  );
}
