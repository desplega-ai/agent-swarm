import { Send } from "lucide-react";
import { useMemo, useState } from "react";
import { useAgentFsAccess, useFolderThreads } from "@/api/hooks/use-agent-fs";
import { SendBatchDialog } from "@/components/comb/send-to-swarm";
import { useCombServiceUserId } from "@/components/comb/use-comb-service-user";
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
  const [open, setOpen] = useState(false);

  return (
    <>
      {mine.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Send ${mine.length} to swarm`}
              className="shrink-0 gap-1.5 px-2 tabular-nums"
              onClick={() => setOpen(true)}
            >
              <Send />
              <span className="hidden sm:inline">Send</span>
              {mine.length}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Send your unsent comments from every file as one task
          </TooltipContent>
        </Tooltip>
      ) : null}
      {open ? (
        <SendBatchDialog
          drive={drive}
          scopePath="/"
          threads={mine}
          showPaths
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
