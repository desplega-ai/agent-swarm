/**
 * The Outputs widget of the Overview (step-10): the files under the group
 * key in the shared drive (drive path = key), newest first, with their
 * author and age. A dot marks a file newer than this browser's last visit
 * to the Overview. A click previews the file in the right column. Files off
 * (Comb disabled): the widget does not render.
 */

import { ExternalLink, FileText, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfig } from "@/hooks/use-config";
import type { LsEntry } from "@/lib/agent-fs/types";
import { childPath, combPath } from "@/lib/comb/paths";
import { cn, formatRelativeTime } from "@/lib/utils";
import { shortAgo } from "../sidebar/session-row";
import type { GroupFiles } from "./use-overview-data";
import { Widget } from "./widget";

const VISIT_PREFIX = "agent-swarm-overview-visit";

/**
 * When this browser last opened the Overview of `groupKey` (ms), read once
 * per mount. The visit is stored after the read, so the dots stay until the
 * next visit.
 */
export function useLastVisit(groupKey: string): number | null {
  const { apiUrl } = useConfig().config;
  const storageKey = `${VISIT_PREFIX}:${apiUrl}:${groupKey}`;
  const [last] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      return stored > 0 ? stored : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(Date.now()));
    } catch {
      // Storage off: every visit is the first.
    }
  }, [storageKey]);
  return last;
}

/** A file is new when it changed after the last visit. A first visit marks none. */
export function isNewSince(entry: LsEntry, lastVisit: number | null): boolean {
  return lastVisit !== null && !!entry.modifiedAt && Date.parse(entry.modifiedAt) > lastVisit;
}

/** The file rows. Mounted only with a listing, so with a drive to name the authors from. */
function FileRows({
  drive,
  files,
  folder,
  lastVisit,
  selected,
  onSelect,
  now,
}: {
  drive: { orgId: string; driveId: string };
  files: LsEntry[];
  folder: string;
  lastVisit: number | null;
  selected: string | null;
  onSelect: (path: string) => void;
  now: number;
}) {
  const authorLabel = useAuthorLabel(drive);
  return (
    <ul
      aria-label="Files in this group"
      className="max-h-100 overflow-y-auto p-1.5 [scrollbar-gutter:stable]"
    >
      {files.map((entry) => {
        const path = childPath(folder, entry.name, false);
        const isNew = isNewSince(entry, lastVisit);
        const active = path === selected;
        return (
          <li key={entry.name}>
            <button
              type="button"
              aria-current={active || undefined}
              onClick={() => onSelect(path)}
              className={cn(
                "flex h-8 w-full min-w-0 items-center gap-2 rounded-md pr-2 pl-1 text-left text-xs hover:bg-accent/60",
                active && "bg-accent",
              )}
            >
              {isNew ? (
                <span
                  role="img"
                  aria-label="New since your last visit"
                  className="size-1.5 shrink-0 rounded-full bg-foreground"
                />
              ) : (
                <span aria-hidden className="size-1.5 shrink-0" />
              )}
              <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-data font-medium">
                {entry.name}
              </span>
              <span className="max-w-28 shrink-0 truncate text-muted-foreground max-sm:hidden">
                {authorLabel(entry.author)}
              </span>
              <span
                title={entry.modifiedAt ? formatRelativeTime(entry.modifiedAt) : undefined}
                className="w-12 shrink-0 text-right font-mono tabular-nums text-muted-foreground"
              >
                {entry.modifiedAt ? shortAgo(entry.modifiedAt, now) : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function OutputsWidget({
  groupKey,
  data,
  selected,
  onSelect,
  now,
}: {
  groupKey: string;
  data: GroupFiles;
  /** The drive path of the file in the preview. */
  selected: string | null;
  onSelect: (path: string) => void;
  now: number;
}) {
  const lastVisit = useLastVisit(groupKey);
  const { files, orgId, driveId, folder, problem } = data;
  const fresh = (files ?? []).filter((entry) => isNewSince(entry, lastVisit)).length;
  const folderHref = orgId && driveId ? combPath({ orgId, driveId, path: folder }) : null;

  return (
    <Widget
      icon={FolderOpen}
      title="Outputs"
      count={files ? `${files.length}${fresh ? ` · ${fresh} new` : ""}` : undefined}
      action={
        folderHref ? (
          <Link
            to={folderHref}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Open folder
            <ExternalLink aria-hidden className="size-3" />
          </Link>
        ) : null
      }
    >
      {problem ? (
        <p className="px-3.5 py-6 text-sm text-muted-foreground">{problem}</p>
      ) : !files ? (
        <div className="space-y-2 p-3.5" aria-busy>
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-5 w-3/5" />
        </div>
      ) : files.length === 0 ? (
        <p className="px-3.5 py-6 text-sm text-muted-foreground">
          No outputs yet. Results land here when a run writes under{" "}
          <span className="font-mono text-xs">{groupKey}</span>.
        </p>
      ) : (
        <FileRows
          drive={{ orgId: orgId ?? "", driveId: driveId ?? "" }}
          files={files}
          folder={folder}
          lastVisit={lastVisit}
          selected={selected}
          onSelect={onSelect}
          now={now}
        />
      )}
    </Widget>
  );
}
