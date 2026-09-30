import { DownloadButton, OpenInAgentFsButton } from "@/components/comb/file-actions";
import { UpdatedChip } from "@/components/comb/live-indicator";
import { PinButton } from "@/components/comb/pin-button";
import { VersionsMenu } from "@/components/comb/review/versions-menu";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { PageHeader } from "@/components/ui/page-header";
import type { StatResult } from "@/lib/agent-fs/types";
import { baseName, type DrivePath } from "@/lib/comb/paths";
import { formatBytes } from "@/lib/format-bytes";
import { formatRelative } from "@/lib/relative-time";

/** File name, version, size, author, and modified time, with the file actions. */
export function FileHeader({ file, stat }: { file: DrivePath; stat: StatResult }) {
  const authorLabel = useAuthorLabel(file);
  const facts = [
    stat.currentVersion !== undefined ? `v${stat.currentVersion}` : null,
    formatBytes(stat.size),
    authorLabel(stat.author),
  ].filter(Boolean);

  return (
    <PageHeader
      title={
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold sm:sr-only">{baseName(file.path)}</h2>
          <p className="flex min-h-5 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            {facts.map((fact) => (
              <span key={fact} className="after:ml-1.5 after:content-['·']">
                {fact}
              </span>
            ))}
            <time dateTime={stat.modifiedAt} title={stat.modifiedAt}>
              {formatRelative(stat.modifiedAt)}
            </time>
            {/* step-11: "Updated to vN" after another actor's version. */}
            <UpdatedChip file={file} />
          </p>
        </div>
      }
      action={
        <>
          {/* File actions: later steps add buttons here. */}
          {/* step-10: Versions menu (compare an older version with the current one). */}
          <VersionsMenu file={file} stat={stat} />
          <PinButton target={file} />
          <DownloadButton file={file} />
          <OpenInAgentFsButton target={file} />
        </>
      }
    />
  );
}
