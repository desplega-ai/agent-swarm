/**
 * "In progress" on Home: running sessions grouped by use case (their
 * Sessions group), with "No group" last. Counts come from the session tree
 * (`GET /api/session-tree`), the rows under each group from one page of
 * running sessions. Workflow runs are not here: there is no global runs
 * endpoint yet.
 */

import { Activity, ChevronRight, FolderOpen, MessageSquare, Star } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useFavorites } from "@/api/hooks/use-favorites";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSessionTree } from "@/api/hooks/use-session-tree";
import { useSessions } from "@/api/hooks/use-sessions";
import type { SessionListItem, SessionTreeResponse } from "@/api/types";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/contexts/current-user-context";
import { groupViewHref, inProgressGroups } from "@/lib/in-progress";
import { groupLabel } from "@/lib/session-groups";
import { SESSIONS_V2_MIN_VERSION } from "@/lib/sessions-v2";
import { taskListTitle } from "@/lib/task-title";
import { formatElapsed } from "@/lib/utils";
import { HomeWidget, HomeWidgetCount, HomeWidgetEmpty, HomeWidgetLink } from "./home-widget";
import { SectionBody, type SectionQuery } from "./section-state";

/** Running sessions fetched for the rows under each group. */
const RUNNING_PAGE = 50;
/** Session rows under one group; the group link opens the rest. */
const ROWS_PER_GROUP = 3;

export function InProgress({ className }: { className?: string }) {
  const supported = useFeatureGate(SESSIONS_V2_MIN_VERSION).supported;
  const tree = useSessionTree({ enabled: supported });
  const running = useSessions({
    status: "running",
    scope: "tree",
    limit: RUNNING_PAGE,
    enabled: supported,
  });
  const starred = useFavorites("key", undefined, { enabled: supported });
  const { data: agents } = useAgents();
  const { userId } = useCurrentUser();

  const agentName = useMemo(() => {
    const names = new Map((agents ?? []).map((a) => [a.id, a.name]));
    return (id: string | null | undefined) => (id ? (names.get(id) ?? null) : null);
  }, [agents]);

  return (
    <InProgressView
      className={className}
      tree={tree}
      running={running.data?.sessions}
      starred={starred.data?.favoriteIds ?? []}
      me={userId ?? null}
      agentName={agentName}
    />
  );
}

export interface InProgressViewProps {
  className?: string;
  tree: SectionQuery<SessionTreeResponse>;
  running: SessionListItem[] | undefined;
  starred: string[];
  me: string | null;
  agentName: (id: string | null | undefined) => string | null;
  /** Folded on a first visit (Home's side column); the tests open it. */
  defaultCollapsed?: boolean;
}

export function InProgressView({
  className,
  tree,
  running,
  starred,
  me,
  agentName,
  defaultCollapsed = true,
}: InProgressViewProps) {
  const groups = useMemo(() => inProgressGroups(tree.data, running, me), [tree.data, running, me]);
  const total = groups.reduce((sum, group) => sum + group.running, 0);
  const labels = tree.data?.labels;

  return (
    <HomeWidget
      className={className}
      title="In progress"
      icon={<Activity className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      meta={tree.data ? <HomeWidgetCount>{total} running</HomeWidgetCount> : null}
      action={<HomeWidgetLink to="/sessions">All sessions</HomeWidgetLink>}
      collapse={{ id: "in-progress", defaultCollapsed }}
    >
      <SectionBody query={tree} what="running sessions">
        {tree.isLoading && !tree.data ? (
          <div className="flex flex-col gap-3 px-4 py-3" aria-busy="true">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : groups.length === 0 ? (
          <HomeWidgetEmpty>Nothing running.</HomeWidgetEmpty>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {groups.map((group) => {
              const name = group.key ? groupLabel(group.key, me, labels) || group.key : "No group";
              const Icon =
                group.key === null
                  ? MessageSquare
                  : starred.includes(group.key)
                    ? Star
                    : FolderOpen;
              return (
                <li key={group.key ?? "nogroup"} className="pb-1.5">
                  <Link
                    to={groupViewHref(group.key)}
                    aria-label={`${name}, ${group.running} running`}
                    className="group/ipg flex h-9 items-center gap-2 pl-4 pr-3 text-[13px] font-semibold outline-none hover:bg-accent focus-visible:bg-accent"
                  >
                    <Icon
                      className={
                        Icon === Star
                          ? "size-3.5 shrink-0 fill-primary text-primary"
                          : "size-3.5 shrink-0 text-muted-foreground"
                      }
                      aria-hidden
                    />
                    <span className="min-w-0 truncate">{name}</span>
                    <span className="font-mono text-xs font-normal tabular-nums text-muted-foreground">
                      {group.running}
                    </span>
                    <ChevronRight
                      className="ml-auto size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  </Link>
                  {group.sessions.slice(0, ROWS_PER_GROUP).map((session) => (
                    <RunningRow
                      key={session.root.id}
                      session={session}
                      agent={agentName(session.root.agentId)}
                    />
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </SectionBody>
    </HomeWidget>
  );
}

function RunningRow({ session, agent }: { session: SessionListItem; agent: string | null }) {
  return (
    <Link
      to={`/sessions/${session.root.id}`}
      className="grid h-9 grid-cols-[14px_minmax(0,1fr)_auto_auto] items-center gap-2.5 pl-[38px] pr-4 text-[13px] outline-none transition-colors hover:bg-accent focus-visible:bg-accent max-sm:pl-4"
    >
      <TaskStatusIcon status="in_progress" label="Running" className="size-3.5" />
      <span className="truncate">{taskListTitle(session.root)}</span>
      <span className="truncate text-xs text-muted-foreground">{agent ?? ""}</span>
      <span className="whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatElapsed(session.root.acceptedAt ?? session.root.createdAt)}
      </span>
    </Link>
  );
}
