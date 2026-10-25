import { FilePen, History, type LucideIcon, Star, Workflow } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router-dom";
import { useFolderThreads } from "@/api/hooks/use-agent-fs";
import type { AgentTask } from "@/api/types";
import {
  FavoritesList,
  RecentChangesList,
  RecentlyViewedList,
} from "@/components/comb/recent-lists";
import { useCombServiceUserId } from "@/components/comb/use-comb-service-user";
import { useWatchedTasks } from "@/components/comb/use-thread-swarm-states";
import { StatusBadge } from "@/components/shared/status-badge";
import { useAgentFs } from "@/contexts/agent-fs-context";
import type { CommentListEntry } from "@/lib/agent-fs/types";
import { commentCombPath } from "@/lib/comb/comments";
import { combPath, pinLabel } from "@/lib/comb/paths";
import type { Drive } from "@/lib/comb/recent";
import { isTaskUnfinished, threadsByTask } from "@/lib/comb/thread-status";
import { formatRelative } from "@/lib/relative-time";
import { statusLabel } from "@/lib/status-labels";
import { cn } from "@/lib/utils";

/** Rows each list card shows. The left panel's Recent and Favorites tabs show the rest. */
const HOME_ROWS = 3;
/** Comments the In progress card shows per task. The task page has them all. */
const TASK_COMMENTS = 3;

const NO_THREADS: CommentListEntry[] = [];

function HomeCard({
  icon: Icon,
  title,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn("flex min-w-0 flex-col rounded-xl border border-border bg-card", className)}
    >
      <h2 className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        {title}
      </h2>
      <div className="p-1">{children}</div>
    </section>
  );
}

/**
 * The Comb home, above the drive root's listing: the swarm tasks working on
 * comments, then the newest favorites, recently viewed files (this browser),
 * and recently changed files (anyone).
 */
export function CombHome({ drive }: { drive: Drive }) {
  return (
    <div className="grid shrink-0 gap-3 md:grid-cols-3">
      <InProgressCard drive={drive} />
      <HomeCard icon={Star} title="Favorites">
        <FavoritesList drive={drive} limit={HOME_ROWS} />
      </HomeCard>
      <HomeCard icon={History} title="Recently viewed">
        <RecentlyViewedList drive={drive} limit={HOME_ROWS} />
      </HomeCard>
      <HomeCard icon={FilePen} title="Recently changed">
        <RecentChangesList drive={drive} limit={HOME_ROWS} />
      </HomeCard>
    </div>
  );
}

/**
 * "In progress": each unfinished swarm task that open comments wait on
 * (`threadsByTask`, the rail's "Processing" rule), newest first, with its
 * comments grouped under it. It reads the drive's comment list (the cached
 * query of the send tray and the root's Open comments panel) and the task
 * queries the comment rails poll. Hidden while nothing is in progress.
 */
function InProgressCard({ drive }: { drive: Drive }) {
  const { features } = useAgentFs();
  const serviceUserId = useCombServiceUserId();
  const query = useFolderThreads({ ...drive, path: "/" }, features.has("comment-path-prefix"));
  const threads = query.data?.threads ?? NO_THREADS;
  const groups = useMemo(() => threadsByTask(threads, serviceUserId), [threads, serviceUserId]);
  const taskIds = useMemo(() => [...groups.keys()].sort(), [groups]);
  const results = useWatchedTasks(taskIds);

  const running = taskIds
    .flatMap((id, index) => {
      const task = results[index]?.data;
      const comments = groups.get(id);
      return task && comments && isTaskUnfinished(task.status) ? [{ task, comments }] : [];
    })
    .sort((a, b) => b.task.createdAt.localeCompare(a.task.createdAt));
  if (running.length === 0) return null;

  return (
    <HomeCard icon={Workflow} title="In progress" className="md:col-span-3">
      <ul className="flex flex-col divide-y divide-border-subtle">
        {running.map(({ task, comments }) => (
          <TaskGroup key={task.id} drive={drive} task={task} comments={comments} />
        ))}
      </ul>
    </HomeCard>
  );
}

/** One task: its status, a link to it, and the comments it works on. */
function TaskGroup({
  drive,
  task,
  comments,
}: {
  drive: Drive;
  task: AgentTask;
  comments: CommentListEntry[];
}) {
  const count = `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`;
  const more = comments.length - TASK_COMMENTS;
  const short = task.id.slice(0, 8);
  const time = formatRelative(task.createdAt);
  return (
    <li className="flex min-w-0 flex-col gap-0.5 py-1.5">
      <Link
        to={`/tasks/${task.id}`}
        aria-label={`Task ${short}, ${statusLabel(task.status)}, ${count}, ${time}`}
        className="hover-linger flex min-w-0 items-center gap-2 rounded-md px-2 py-1 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <StatusBadge status={task.status} />
        <span className="text-sm font-medium">{count}</span>
        <span className="font-mono text-xs text-muted-foreground">{short}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{time}</span>
      </Link>
      <ul aria-label={`Comments in task ${short}`} className="flex flex-col">
        {comments.slice(0, TASK_COMMENTS).map((thread) => {
          const path = commentCombPath(thread.path);
          return (
            <li key={thread.id} className="min-w-0">
              <Link
                to={`${combPath({ ...drive, path })}?comment=${encodeURIComponent(thread.id)}`}
                title={path}
                className="hover-linger flex min-w-0 items-baseline gap-2 rounded-md py-1 pr-2 pl-9 text-sm outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <span className="max-w-[40%] shrink-0 truncate font-mono text-xs text-muted-foreground">
                  {pinLabel(path)}
                </span>
                <span className="min-w-0 flex-1 truncate">{thread.body}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      {more > 0 ? (
        <p className="pl-9 text-xs text-muted-foreground">
          {more} more {more === 1 ? "comment" : "comments"}
        </p>
      ) : null}
    </li>
  );
}
