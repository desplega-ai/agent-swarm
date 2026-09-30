import { useEffect, useState } from "react";
import { StatusIcon, type StatusTone } from "@/components/shared/status-icon";
import { Badge } from "@/components/ui/badge";
import { type LiveState, useAgentFs } from "@/contexts/agent-fs-context";
import { combEventPath } from "@/lib/agent-fs/invalidation";
import type { DrivePath } from "@/lib/comb/paths";

/**
 * `busy` only while a connection opens (a real wait). Polling still
 * refreshes the view, so its states get the quiet `saved` check, and a
 * refused stream gets `warning`.
 */
const TONE: Record<LiveState, StatusTone> = {
  live: "success",
  connecting: "busy",
  retrying: "busy",
  stopped: "warning",
  paused: "saved",
  off: "saved",
};

function liveReason(state: LiveState, hasStream: boolean, relayed: boolean): string {
  switch (state) {
    case "live":
      return relayed
        ? "Another Comb tab holds the change stream for this drive and sends its changes to this tab."
        : "Changes from agents and teammates show without a reload.";
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

/**
 * "Live" while the drive's change stream is up, "Polling" otherwise. The
 * reason is the `StatusIcon` label: its tooltip, its focus stop, and its
 * polite live region.
 */
export function LiveIndicator() {
  const { liveState, liveRelayed, features } = useAgentFs();
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <StatusIcon
        tone={TONE[liveState]}
        label={liveReason(liveState, features.has("change-stream"), liveRelayed)}
      />
      {liveState === "live" ? "Live" : "Polling"}
    </span>
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
        <Badge
          variant="outline"
          size="tag"
          className="border-status-info/30 text-status-info-strong"
        >
          Updated to v{version}
        </Badge>
      )}
    </span>
  );
}
