import { useQuery } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { agentFsCommentsKey, agentFsRetry, useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { SendBatchButton } from "@/components/comb/send-to-swarm";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { useCombServiceUserId } from "@/components/comb/use-comb-service-user";
import { Badge } from "@/components/ui/badge";
import { useAgentFs } from "@/contexts/agent-fs-context";
import type { AgentFsClient } from "@/lib/agent-fs/client";
import type { CommentListEntry, CommentListResult } from "@/lib/agent-fs/types";
import { type FileThreads, listFileThreads } from "@/lib/comb/comments";
import { hasSwarmMarker, isSentToSwarm } from "@/lib/comb/markers";
import { combPath, type DrivePath } from "@/lib/comb/paths";

/**
 * Open root comments on every file below `folder` (`comment-list
 * {pathPrefix}`, agent-fs feature `comment-path-prefix`). The key lives under
 * the drive's comment prefix, so a send or a new comment refreshes it.
 */
function useFolderComments(folder: DrivePath, enabled: boolean) {
  const access = useAgentFsAccess();
  return useQuery({
    queryKey: agentFsCommentsKey(access, folder, "prefix", folder.path),
    queryFn: ({ signal }): Promise<FileThreads> =>
      listFileThreads([folder.path], async (pathPrefix, offset, limit) => {
        const page = await (access.client as AgentFsClient).callOp<CommentListResult>(
          folder.orgId,
          "comment-list",
          { pathPrefix, limit, offset },
          folder.driveId,
          { signal },
        );
        return page.comments;
      }),
    enabled: enabled && access.client !== null,
    retry: agentFsRetry,
    refetchInterval: 10_000, // step-11: drivePoll
  });
}

/** agent-fs returns comment paths in either stored form. Comb paths start with "/". */
function normalizedPath(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}

/**
 * The folder's "Open comments" panel: open threads grouped by file, with
 * "Send N to swarm" for the whole folder. Hidden when agent-fs lacks the
 * `comment-path-prefix` feature or the folder has no open comments.
 */
export function FolderComments({ folder }: { folder: DrivePath }) {
  const { features } = useAgentFs();
  const supported = features.has("comment-path-prefix");
  const query = useFolderComments(folder, supported);
  const authorLabel = useAuthorLabel(folder);
  const serviceUserId = useCombServiceUserId();
  const threads = query.data?.threads;

  const groups = useMemo(() => {
    const byPath = new Map<string, CommentListEntry[]>();
    for (const thread of threads ?? []) {
      const path = normalizedPath(thread.path);
      byPath.set(path, [...(byPath.get(path) ?? []), thread]);
    }
    return [...byPath].sort(([a], [b]) => a.localeCompare(b));
  }, [threads]);

  if (!supported || !threads?.length) return null;

  return (
    <section
      aria-label="Open comments"
      className="flex max-h-80 shrink-0 flex-col rounded-xl border border-border bg-card"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
          Open comments
          <span className="text-muted-foreground tabular-nums">{threads.length}</span>
        </h2>
        <SendBatchButton drive={folder} scopePath={folder.path} threads={threads} showPaths />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.data?.truncated ? (
          <p className="px-3 pt-2 text-xs text-muted-foreground">
            Showing the newest {threads.length.toLocaleString()} comments.
          </p>
        ) : null}
        {groups.map(([path, fileThreads]) => (
          <div key={path} className="border-b border-border-subtle px-3 py-2 last:border-b-0">
            <Link
              to={combPath({ ...folder, path })}
              className="font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {path.slice(folder.path.length) || path}
            </Link>
            <ul className="mt-1 flex flex-col">
              {fileThreads.map((thread) => (
                <li key={thread.id}>
                  <Link
                    to={`${combPath({ ...folder, path })}?comment=${encodeURIComponent(thread.id)}`}
                    className="hover-linger flex min-w-0 items-baseline gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-accent/50"
                  >
                    <span className="max-w-[40%] shrink-0 truncate text-xs font-medium">
                      {thread.authorDisplayName || authorLabel(thread.author)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{thread.body}</span>
                    {isSentToSwarm(thread, serviceUserId) ? (
                      <Badge variant="outline" size="tag" className="shrink-0">
                        Sent
                      </Badge>
                    ) : hasSwarmMarker(thread.body) ? (
                      <Badge
                        variant="outline"
                        size="tag"
                        className="shrink-0 border-status-info/40 text-status-info-strong"
                      >
                        @swarm
                      </Badge>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
