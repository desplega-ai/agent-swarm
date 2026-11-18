import { ListTree } from "lucide-react";
import { type RefObject, useMemo, useReducer, useState } from "react";
import { useAgentFsText } from "@/api/hooks/use-agent-fs";
import { useTask } from "@/api/hooks/use-tasks";
import { useStatusContext } from "@/app/status-context";
import { CommentRail } from "@/components/comb/comment-rail";
import { renderMentionPicker } from "@/components/comb/mention-picker";
import { OutlineList } from "@/components/comb/outline-list";
import { SendBatchButton } from "@/components/comb/send-to-swarm";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { StatResult } from "@/lib/agent-fs/types";
import { getFileKind } from "@/lib/comb/file-kinds";
import { extractOutline, hasOutline } from "@/lib/comb/outline";
import type { DrivePath } from "@/lib/comb/paths";
import type { LinkPreviewTarget } from "@/lib/link-preview";
import { taskListTitle } from "@/lib/task-title";

type ViewerRef = RefObject<HTMLDivElement | null>;

function OutlineButton({ file, viewerRef }: { file: DrivePath; viewerRef: ViewerRef }) {
  const { data } = useAgentFsText(file);
  const headings = useMemo(() => (data && !data.tooLarge ? extractOutline(data.text) : []), [data]);
  const [open, setOpen] = useState(false);
  if (!hasOutline(headings)) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Outline" title="Outline">
          <ListTree />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="File outline"
        className="max-h-[min(24rem,var(--radix-popover-content-available-height))] overflow-auto p-0"
      >
        <OutlineList
          preview={{ viewer: viewerRef.current, headings }}
          onNavigate={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

export default function FileReviewControls({
  target,
  stat,
  viewerRef,
}: {
  target: Extract<LinkPreviewTarget, { kind: "file" }>;
  stat: StatResult;
  viewerRef: ViewerRef;
}) {
  const { file, origin } = target;
  const [readOnly, markReadOnly] = useReducer(() => true, false);
  const comb = useStatusContext().data?.agent_fs?.comb;
  const canSend =
    comb?.review_follow_ups && comb.org_id === file.orgId && comb.drive_id === file.driveId;
  const parent = useTask(canSend && origin ? origin.id : "", { refetchInterval: false }).data;
  const preview = useMemo(
    () => ({
      commentId: new URL(target.route, window.location.origin).searchParams.get("comment"),
    }),
    [target.route],
  );
  return (
    <>
      {getFileKind(file.path, stat.contentType, stat.size) === "markdown" && (
        <OutlineButton file={file} viewerRef={viewerRef} />
      )}
      <CommentRail
        file={file}
        stat={stat}
        viewerRef={viewerRef}
        readOnly={readOnly}
        onReadOnly={markReadOnly}
        preview={preview}
        renderComposerExtras={renderMentionPicker}
        sendAction={
          origin && parent && canSend
            ? ({ open }) => (
                <SendBatchButton
                  drive={file}
                  scopePath={file.path}
                  threads={open}
                  destination={{ ...origin, title: taskListTitle(parent) }}
                />
              )
            : undefined
        }
      />
    </>
  );
}
