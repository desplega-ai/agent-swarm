import { History } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useAgentFsLog } from "@/api/hooks/use-agent-fs";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { StatResult } from "@/lib/agent-fs/types";
import type { DrivePath } from "@/lib/comb/paths";
import { DIFF_PARAM, formatDiffRange, showReviewEntry } from "@/lib/comb/review";
import { formatRelative } from "@/lib/relative-time";

/**
 * The file's versions (`log`), for text files only (`showReviewEntry`).
 * Picking an older one compares it with the current version
 * (`?diff=<picked>..<current>`, a new history entry, no linked thread). The
 * log loads when the menu opens.
 */
export function VersionsMenu({ file, stat }: { file: DrivePath; stat: StatResult }) {
  const [, setSearchParams] = useSearchParams();
  const current = stat.currentVersion;
  if (current === undefined || !showReviewEntry(file.path, stat)) return null;
  // Nothing to compare yet: a blocked button that says why, no menu.
  if (current <= 1) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            aria-disabled="true"
            aria-label="Versions"
            className="aria-disabled:opacity-50"
            onClick={(event) => event.preventDefault()}
          >
            <History />
            <span className="hidden sm:inline">Versions</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Only one version so far</TooltipContent>
      </Tooltip>
    );
  }

  const compare = (version: number) =>
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.set(DIFF_PARAM, formatDiffRange({ from: version, to: current }));
      // A compare is not a thread's review: it resolves nothing.
      next.delete("comment");
      return next;
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" aria-label="Versions">
          <History />
          <span className="hidden sm:inline">Versions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Compare with v{current}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <VersionItems file={file} current={current} onCompare={compare} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function VersionItems({
  file,
  current,
  onCompare,
}: {
  file: DrivePath;
  current: number;
  onCompare: (version: number) => void;
}) {
  const log = useAgentFsLog(file, current);
  const authorLabel = useAuthorLabel(file);

  if (log.isPending) {
    return <DropdownMenuItem disabled>Loading versions…</DropdownMenuItem>;
  }
  if (log.error) {
    return <DropdownMenuItem disabled>{log.error.message}</DropdownMenuItem>;
  }
  return log.data.versions.map((entry) => (
    <DropdownMenuItem
      key={entry.version}
      disabled={entry.version >= current}
      onSelect={() => onCompare(entry.version)}
      className="flex-col items-start gap-0.5"
    >
      <span className="flex w-full items-center gap-1.5">
        <span className="font-mono text-xs font-medium">v{entry.version}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {authorLabel(entry.author)} · {formatRelative(entry.createdAt)}
        </span>
        {entry.version === current ? (
          <Badge variant="outline" size="tag">
            Current
          </Badge>
        ) : entry.operation === "revert" ? (
          <Badge variant="outline" size="tag">
            Revert
          </Badge>
        ) : null}
      </span>
      {entry.message ? (
        <span className="w-full truncate text-xs text-muted-foreground">{entry.message}</span>
      ) : null}
    </DropdownMenuItem>
  ));
}
