/**
 * Sessions surface — chat-style bubble for a user-initiated message.
 *
 * Used for both the session root prompt and any follow-up tasks created via
 * the composer (i.e. tasks with `requestedByUserId` set). The bubble is
 * right-aligned with left-aligned text inside, capped at a sensible
 * max-width so long prompts read like a real chat message instead of
 * cascading down the page as a giant right-aligned block.
 */

import { ExternalLink, Paperclip } from "lucide-react";
import { useUsers } from "@/api/hooks/use-users";
import type { TaskAttachment } from "@/api/types";
import { buildAgentFsLiveUrl } from "@/components/shared/task-attachments-section";
import { cn } from "@/lib/utils";

export interface UserPromptBubbleProps {
  text: string;
  /** Look up the requester's display name from the users cache. */
  requestedByUserId: string | null | undefined;
  createdAt: string;
  attachments?: TaskAttachment[];
  className?: string;
}

const USER_UPLOAD_ATTACHMENT_MARKER = "\n\n---\nUser-uploaded attachments:\n";

function visibleMessageText(text: string): string {
  const markerIndex = text.indexOf(USER_UPLOAD_ATTACHMENT_MARKER);
  return (markerIndex === -1 ? text : text.slice(0, markerIndex)).trimEnd();
}

function attachmentHref(attachment: TaskAttachment): string | null {
  switch (attachment.kind) {
    case "agent-fs":
      return buildAgentFsLiveUrl({
        path: attachment.path,
        orgId: attachment.orgId,
        driveId: attachment.driveId,
      });
    case "url":
      return attachment.url ?? null;
    case "page":
      return attachment.pageId ? `/pages/${attachment.pageId}` : null;
    case "shared-fs":
      return null;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function UserAttachmentList({ attachments }: { attachments: TaskAttachment[] | undefined }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {attachments.map((attachment) => {
        const href = attachmentHref(attachment);
        const label = (
          <>
            <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{attachment.name}</span>
            {attachment.sizeBytes != null ? (
              <span className="font-mono text-[10px] text-muted-foreground">
                {formatFileSize(attachment.sizeBytes)}
              </span>
            ) : null}
            {href ? <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}
          </>
        );
        const className = cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border",
          "bg-background/70 px-2 py-1 text-xs text-foreground/90",
        );
        return href ? (
          <a
            key={attachment.id}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={className}
          >
            {label}
          </a>
        ) : (
          <span key={attachment.id} className={className}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

export function UserPromptBubble({
  text,
  requestedByUserId,
  createdAt,
  attachments,
  className,
}: UserPromptBubbleProps) {
  const { data: users } = useUsers();
  const requesterName =
    (requestedByUserId && users?.find((u) => u.id === requestedByUserId)?.name) || "User";
  const date = new Date(createdAt);
  const dateLabel = date.toLocaleString();
  const displayText = visibleMessageText(text);
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
        <div
          className={cn(
            "rounded-2xl rounded-tr-sm bg-muted px-4 py-2.5",
            "text-sm leading-relaxed text-foreground/95",
            "whitespace-pre-wrap break-words text-left min-w-0",
          )}
        >
          {displayText ? <div>{displayText}</div> : null}
          <UserAttachmentList attachments={attachments} />
        </div>
      </div>
    </section>
  );
}
