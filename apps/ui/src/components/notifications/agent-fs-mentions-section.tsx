import { CheckCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useAgentFsMentions, useDriveMembers, useMarkMentionsRead } from "@/api/hooks/use-agent-fs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { CommentNotificationEntry } from "@/lib/agent-fs/types";
import { commentWritePath } from "@/lib/comb/comments";
import { mentionRoute } from "@/lib/comb/mentions";
import { baseName, parentFolder } from "@/lib/comb/paths";
import { formatRelative } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

interface AgentFsMentionsSectionProps {
  /** The swarm drive (`useAgentFs()`), where the mentions live. */
  drive: { orgId: string; driveId: string };
  /** A mention was opened: close the panel. */
  onNavigate: () => void;
}

/**
 * Comb mentions of the connected agent-fs identity on the swarm drive. A
 * click opens the comment's thread and marks that mention read. Opening the
 * panel does not mark mentions read.
 */
export function AgentFsMentionsSection({ drive, onNavigate }: AgentFsMentionsSectionProps) {
  const { query } = useAgentFsMentions();
  const markRead = useMarkMentionsRead();
  const members = useDriveMembers(drive).data?.members;
  const actorName = (userId: string) => {
    const member = members?.find((m) => m.userId === userId);
    return member ? member.displayName || member.email : "someone";
  };
  const notifications = query.data?.notifications ?? [];
  const unreadCount = query.data?.unreadCount ?? 0;

  return (
    <section aria-labelledby="agent-fs-mentions-heading" className="flex flex-col py-1">
      <div className="flex items-center justify-between gap-2 py-1 pr-2 pl-4">
        <h4
          id="agent-fs-mentions-heading"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Mentions
        </h4>
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          disabled={unreadCount === 0 || markRead.isPending}
          onClick={() => markRead.mutate({ all: true })}
        >
          <CheckCheck />
          Mark all read
        </Button>
      </div>
      {query.isPending ? (
        <div className="flex flex-col gap-2 px-4 py-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : query.error && !query.data ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">Could not load mentions.</p>
      ) : notifications.length === 0 ? (
        <p className="px-4 py-2 text-sm text-muted-foreground">No mentions</p>
      ) : (
        <ul className="flex flex-col">
          {notifications.map((entry) => (
            <li key={entry.id}>
              <MentionItem
                entry={entry}
                actor={actorName(entry.actor)}
                to={mentionRoute(drive, entry)}
                onOpen={() => {
                  if (!entry.read) markRead.mutate({ ids: [entry.id] });
                  onNavigate();
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MentionItem({
  entry,
  actor,
  to,
  onOpen,
}: {
  entry: CommentNotificationEntry;
  actor: string;
  to: string;
  onOpen: () => void;
}) {
  const path = `/${commentWritePath(entry.path)}`;
  return (
    <Link
      to={to}
      onClick={onOpen}
      className="hover-linger flex gap-2.5 px-4 py-2 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
    >
      <span
        aria-hidden
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", entry.read ? "" : "bg-primary")}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-1.5 text-xs">
          {entry.read ? null : <span className="sr-only">Unread.</span>}
          <span className="truncate font-medium">{actor}</span>
          <span className="shrink-0 text-muted-foreground">mentioned you</span>
          <time
            dateTime={entry.createdAt}
            title={entry.createdAt}
            className="ml-auto shrink-0 text-muted-foreground"
          >
            {formatRelative(entry.createdAt)}
          </time>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          <span className="text-foreground">{baseName(path)}</span> in {parentFolder(path)}
        </span>
        <span className="truncate text-sm">{entry.body.replace(/\s+/g, " ")}</span>
      </span>
    </Link>
  );
}
