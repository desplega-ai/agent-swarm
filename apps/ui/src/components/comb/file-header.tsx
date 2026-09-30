import { useAgentFsStat } from "@/api/hooks/use-agent-fs";
import { FolderTrail } from "@/components/comb/breadcrumbs";
import { DownloadButton, OpenInAgentFsButton } from "@/components/comb/file-actions";
import { UpdatedChip } from "@/components/comb/live-indicator";
import { PinButton } from "@/components/comb/pin-button";
import { PresenceAvatars } from "@/components/comb/presence-avatars";
import { VersionsMenu } from "@/components/comb/review/versions-menu";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { MiddleTruncation } from "@/components/ui/middle-truncation";
import type { StatResult } from "@/lib/agent-fs/types";
import { baseName, type DrivePath } from "@/lib/comb/paths";
import { formatRelative } from "@/lib/relative-time";

/** The file's `stat` once it is a versioned file (a folder URL without its "/" has no version). */
function useFileStat(file: DrivePath): StatResult | null {
  const stat = useAgentFsStat(file).data;
  return stat && stat.currentVersion !== undefined ? stat : null;
}

/** The page title for a file: its folders as a short muted trail, then the name. */
export function FileTitle({ file }: { file: DrivePath }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <FolderTrail file={file} />
      <h1 className="flex min-w-0 flex-1 text-base font-semibold leading-6">
        <MiddleTruncation>{baseName(file.path)}</MiddleTruncation>
      </h1>
    </div>
  );
}

/** Under the title: the version, the author, and the modified time. */
export function FileSubtitle({ file }: { file: DrivePath }) {
  const stat = useFileStat(file);
  return (
    // A fixed height: the "Updated to vN" chip does not move the page.
    <p className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      {stat ? <FileFacts file={file} stat={stat} /> : null}
    </p>
  );
}

function FileFacts({ file, stat }: { file: DrivePath; stat: StatResult }) {
  const authorLabel = useAuthorLabel(file);
  const author = authorLabel(stat.author);
  return (
    <>
      <span className="after:ml-1.5 after:content-['·']">v{stat.currentVersion}</span>
      {/* Phones keep the version and the time. */}
      {author ? (
        <span className="hidden after:ml-1.5 after:content-['·'] sm:inline">{author}</span>
      ) : null}
      <time dateTime={stat.modifiedAt} title={stat.modifiedAt}>
        {formatRelative(stat.modifiedAt)}
      </time>
      {/* step-11: "Updated to vN" after another actor's version. */}
      <UpdatedChip file={file} />
    </>
  );
}

/**
 * The other people on the file, then its actions as icon buttons: Versions,
 * Pin, Download, Open in agent-fs.
 */
export function FileActions({ file }: { file: DrivePath }) {
  const stat = useFileStat(file);
  if (!stat) return null;
  return (
    <>
      <PresenceAvatars path={file.path} version={stat.currentVersion} />
      {/* step-10: Versions menu (compare an older version with the current one). */}
      <VersionsMenu file={file} stat={stat} />
      <PinButton target={file} className="size-8" />
      <DownloadButton file={file} bytes={stat.size} iconOnly />
      <OpenInAgentFsButton target={file} iconOnly />
    </>
  );
}
