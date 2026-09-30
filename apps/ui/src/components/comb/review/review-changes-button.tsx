import { GitCompareArrows } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useAgentFsLog } from "@/api/hooks/use-agent-fs";
import { Button } from "@/components/ui/button";
import type { CommentListEntry, StatResult } from "@/lib/agent-fs/types";
import type { DrivePath } from "@/lib/comb/paths";
import { DIFF_PARAM, formatDiffRange, reviewRange, showReviewEntry } from "@/lib/comb/review";

interface ReviewChangesButtonProps {
  file: DrivePath;
  stat: StatResult;
  thread: CommentListEntry;
}

/**
 * "Review changes (v1 → v3)" on a thread whose file has a version newer than
 * the one the comment was made on (text files only, `showReviewEntry`). It
 * opens `?diff=<from>..<to>&comment=<id>` as a new history entry, so Back
 * returns to the file view. The rail closes its narrow-layout sheet for it.
 */
export function ReviewChangesButton({ file, stat, thread }: ReviewChangesButtonProps) {
  const [, setSearchParams] = useSearchParams();
  const shown = showReviewEntry(file.path, stat);
  // Only a comment without `fileVersion` needs the log (the anchors share it).
  const log = useAgentFsLog(file, stat.currentVersion, {
    enabled: shown && thread.fileVersion == null,
  });
  const range = shown ? reviewRange(thread, stat.currentVersion, log.data?.versions) : null;
  if (!range) return null;

  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-muted-foreground"
      onClick={(event) => {
        // A card click is its own navigation: it selects the thread from the
        // URL of this render (react-router), and it leaves a review. Bubbling
        // up, it would replace this new entry and drop `diff`. This click
        // selects the thread itself.
        event.stopPropagation();
        setSearchParams((params) => {
          const next = new URLSearchParams(params);
          next.set(DIFF_PARAM, formatDiffRange(range));
          next.set("comment", thread.id);
          return next;
        });
      }}
    >
      <GitCompareArrows />
      Review changes (v{range.from} → v{range.to})
    </Button>
  );
}
