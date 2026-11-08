/**
 * The preview of the selected output (step-10): the light Comb viewer
 * (`FileViewer`, no comment rail) under a header with the name, the age,
 * the size, and "Open in Files". The footer names who wrote it, and the
 * session it came from when a recent session of the group attached it.
 */

import { useQueries, useQuery } from "@tanstack/react-query";
import { ExternalLink, FileText } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { useAgentFsStat } from "@/api/hooks/use-agent-fs";
import { sessionsQueryOptions } from "@/api/hooks/use-sessions";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { FileViewer } from "@/components/comb/viewers/file-viewer";
import { ViewerSkeleton } from "@/components/comb/viewers/viewer-skeleton";
import { useCurrentUser } from "@/contexts/current-user-context";
import { baseName, combPath, type DrivePath } from "@/lib/comb/paths";
import { formatBytes } from "@/lib/format-bytes";
import { sessionDisplayTitle } from "@/lib/utils";
import { shortAgo } from "../sidebar/session-row";
import { useAgentNames } from "./run-now";

/** The recent sessions of a group the preview looks in for the file's task. */
const ATTACHMENT_LOOKBACK = 5;

const trimSlash = (path: string) => path.replace(/^\/+/, "");

/**
 * The session whose root attached this file (an agent-fs attachment with
 * the same path), among the group's newest sessions. Null when none did.
 */
function useFileSession(groupKey: string, file: DrivePath) {
  const { userId } = useCurrentUser();
  // One-off lookups: they skip the app-wide 10 s poll.
  const recent = useQuery({
    ...sessionsQueryOptions(userId ?? null, {
      scope: "tree",
      groupKey,
      limit: ATTACHMENT_LOOKBACK,
    }),
    refetchInterval: false,
  }).data?.sessions;
  const lookups = useQueries({
    queries: (recent ?? []).map((session) => ({
      queryKey: ["task", session.root.id, "fs-files"],
      queryFn: () => api.fetchTaskFiles(session.root.id),
      staleTime: 60_000,
      refetchInterval: false as const,
    })),
  });
  const wanted = trimSlash(file.path);
  for (const [index, lookup] of lookups.entries()) {
    const attachment = lookup.data?.attachments.find(
      (item) => item.kind === "agent-fs" && item.path && trimSlash(item.path) === wanted,
    );
    const session = recent?.[index];
    if (attachment && session) return { session, agentId: attachment.agentId };
  }
  return null;
}

export function FilePreview({
  groupKey,
  file,
  now,
  onOpen,
}: {
  groupKey: string;
  file: DrivePath;
  now: number;
  onOpen: (rootTaskId: string) => void;
}) {
  const stat = useAgentFsStat(file);
  const source = useFileSession(groupKey, file);
  const agentName = useAgentNames();
  const authorLabel = useAuthorLabel(file);
  const name = baseName(file.path);
  const writer = source?.agentId
    ? agentName(source.agentId)
    : authorLabel(stat.data?.author) || null;

  return (
    <section
      aria-label={`Preview of ${name}`}
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3.5">
        <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 truncate font-mono text-data font-medium">{name}</h3>
        {stat.data ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {shortAgo(stat.data.modifiedAt, now)} · {formatBytes(stat.data.size)}
          </span>
        ) : null}
        <span className="flex-1" />
        <Link
          to={combPath(file)}
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Open in Files
          <ExternalLink aria-hidden className="size-3" />
        </Link>
      </header>
      <div className="max-h-105 min-h-40 overflow-y-auto [scrollbar-gutter:stable]">
        {stat.data ? (
          <FileViewer file={file} stat={stat.data} />
        ) : stat.isError ? (
          <p className="text-sm text-muted-foreground">This file cannot be read right now.</p>
        ) : (
          <ViewerSkeleton />
        )}
      </div>
      {writer || source ? (
        <footer className="flex min-h-9 shrink-0 items-center gap-1.5 border-t border-border-subtle px-3.5 text-xs text-muted-foreground">
          <span className="truncate">
            {writer ? <>{writer} wrote it</> : "Written"}
            {source ? " in " : null}
          </span>
          {source ? (
            <button
              type="button"
              onClick={() => onOpen(source.session.root.id)}
              className="min-w-0 truncate font-medium text-foreground hover:underline"
            >
              {sessionDisplayTitle(source.session.root)}
            </button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}
