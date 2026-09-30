import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type LiveState, useAgentFs } from "@/contexts/agent-fs-context";
import { combEventPath } from "@/lib/agent-fs/invalidation";
import type { DrivePath } from "@/lib/comb/paths";
import { cn } from "@/lib/utils";

const DOT: Record<LiveState, string> = {
  live: "bg-status-success",
  connecting: "bg-status-pending",
  retrying: "bg-status-pending",
  stopped: "bg-status-neutral",
  paused: "bg-status-neutral",
  off: "bg-status-neutral",
};

function liveReason(state: LiveState, hasStream: boolean): string {
  switch (state) {
    case "live":
      return "Changes from agents and teammates show without a reload.";
    case "connecting":
      return "Comb checks for changes every 10 s until the change stream connects.";
    case "retrying":
      return "The change stream dropped. Comb checks every 10 s while it reconnects.";
    case "stopped":
      return "agent-fs refused the change stream. Comb checks for changes every 10 s.";
    case "paused":
      return "The change stream pauses while this tab is in the background.";
    case "off":
      return hasStream
        ? "Comb checks for changes every 10 s."
        : "This agent-fs server has no change stream. Comb checks for changes every 10 s.";
  }
}

/** "Live" while the drive's change stream is up, "Polling" otherwise. The tooltip says why. */
export function LiveIndicator() {
  const { liveState, features } = useAgentFs();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" tabIndex={0} className="gap-1.5">
          <span aria-hidden className={cn("size-1.5 rounded-full", DOT[liveState])} />
          {liveState === "live" ? "Live" : "Polling"}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {liveReason(liveState, features.has("change-stream"))}
      </TooltipContent>
    </Tooltip>
  );
}

const UPDATED_CHIP_MS = 10_000;

/**
 * "Updated to vN" for 10 s after someone else commits a version of `file`.
 * The new content loads through the stream's query invalidation.
 */
export function UpdatedChip({ file }: { file: DrivePath }) {
  const { subscribeLive, credential } = useAgentFs();
  const userId = credential?.userId ?? null;
  const { driveId, path } = file;
  const [version, setVersion] = useState<number | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeLive((event) => {
      if (event.type !== "file.changed" || event.operation === "delete") return;
      if (event.driveId !== driveId || combEventPath(event.path) !== path) return;
      if (event.actor === userId) return;
      setVersion(event.version);
      clearTimeout(timer);
      timer = setTimeout(() => setVersion(null), UPDATED_CHIP_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [subscribeLive, driveId, path, userId]);

  return (
    <span aria-live="polite">
      {version === null ? null : (
        <Badge variant="outline" className="border-status-info/30 py-0 text-status-info-strong">
          Updated to v{version}
        </Badge>
      )}
    </span>
  );
}
