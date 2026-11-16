import { Send, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useAgentFsAccess, useFolderThreads } from "@/api/hooks/use-agent-fs";
import { SendBatchDialog } from "@/components/comb/send-to-swarm";
import { useCombServiceUserId } from "@/components/comb/use-comb-service-user";
import { useDismissedSends } from "@/components/comb/use-dismissed-sends";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentFs } from "@/contexts/agent-fs-context";
import type { CommentListEntry } from "@/lib/agent-fs/types";
import { myUnsent } from "@/lib/comb/batch";

type Drive = { orgId: string; driveId: string };

const NO_THREADS: CommentListEntry[] = [];

/**
 * The send tray: "Send N" in the Comb header on every page, while the
 * connected person has comments that were not sent to the swarm. One dialog
 * lists them from every file, grouped by file, and sends the checked ones as
 * one task (like the page feedback panel, across files). It reads the
 * drive's comment list, the same cached query as the root's Open comments
 * panel. Hidden when agent-fs lacks the `comment-path-prefix` feature.
 * Comments dismissed in the dialog (`useDismissedSends`) do not count and
 * list apart, where they can be restored. With every comment dismissed, a
 * muted "N dismissed" button stays, so the Dismissed list stays reachable.
 */
export function SendTrayButton({ drive }: { drive: Drive }) {
  const { features } = useAgentFs();
  const supported = features.has("comment-path-prefix");
  const access = useAgentFsAccess();
  const serviceUserId = useCombServiceUserId();
  const query = useFolderThreads({ ...drive, path: "/" }, supported);
  const threads = query.data?.threads ?? NO_THREADS;
  const mine = useMemo(
    () => myUnsent(threads, access.userId, serviceUserId),
    [threads, access.userId, serviceUserId],
  );
  const dismissal = useDismissedSends(drive);
  const active = mine.filter((thread) => !dismissal.ids.has(thread.id));
  const dismissedCount = mine.length - active.length;
  const [open, setOpen] = useState(false);

  return (
    <>
      {active.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Send ${active.length} to swarm`}
              className="shrink-0 gap-1.5 px-2 tabular-nums"
              onClick={() => setOpen(true)}
            >
              <Send />
              <span className="hidden sm:inline">Send</span>
              {active.length}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Send your unsent comments from every file as one task
          </TooltipContent>
        </Tooltip>
      ) : dismissedCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Show ${dismissedCount} dismissed comments`}
              className="shrink-0 gap-1.5 px-2 text-muted-foreground tabular-nums"
              onClick={() => setOpen(true)}
            >
              <Undo2 />
              <span className="hidden sm:inline">Dismissed</span>
              {dismissedCount}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Every unsent comment is dismissed. Open to restore one
          </TooltipContent>
        </Tooltip>
      ) : null}
      {open ? (
        <SendBatchDialog
          drive={drive}
          scopePath="/"
          threads={mine}
          showPaths
          dismissal={dismissal}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
