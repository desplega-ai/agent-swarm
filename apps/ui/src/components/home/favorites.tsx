/**
 * Favorites on Home: every starred use case (a Sessions group key), page,
 * workflow, schedule and agent-fs path of the picked user, newest star first.
 * A star can outlive its item: a deleted group, page or schedule still lists,
 * with a muted note, so the user can open it or unstar it where it lived.
 */

import type { LucideIcon } from "lucide-react";
import { Clock, File, FolderOpen, Globe, Star, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useFavorites } from "@/api/hooks/use-favorites";
import { usePage } from "@/api/hooks/use-pages";
import { useScheduledTask } from "@/api/hooks/use-schedules";
import { useSessionTree } from "@/api/hooks/use-session-tree";
import { useWorkflow } from "@/api/hooks/use-workflows";
import type { UserFavorite } from "@/api/types";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { useCurrentUser } from "@/contexts/current-user-context";
import { favoriteHref, favoriteKind, mergeFavorites } from "@/lib/home-favorites";
import { groupLabel } from "@/lib/session-groups";
import { cn, formatRelativeTime, formatSmartTime } from "@/lib/utils";
import { HomeWidget, HomeWidgetCount, HomeWidgetEmpty } from "./home-widget";
import { SectionBody, type SectionQuery } from "./section-state";

export function Favorites({ className }: { className?: string }) {
  const queries = [
    useFavorites("key"),
    useFavorites("page"),
    useFavorites("workflow"),
    useFavorites("schedule"),
    useFavorites("agent-fs-path"),
  ];
  const favorites = mergeFavorites(queries.map((query) => query.data?.favorites));
  // One read state for the whole list: the first failed type stands for all.
  const failed = queries.find((query) => query.isError) ?? queries[0];
  const state: SectionQuery<unknown> = {
    data: queries.every((query) => query.data) ? favorites : undefined,
    isLoading: queries.some((query) => query.isLoading),
    isError: queries.some((query) => query.isError),
    errorUpdateCount: Math.max(...queries.map((query) => query.errorUpdateCount)),
    refetch: () => failed.refetch(),
  };
  return <FavoritesView className={className} favorites={favorites} state={state} />;
}

export function FavoritesView({
  className,
  favorites,
  state,
}: {
  className?: string;
  favorites: UserFavorite[];
  state: SectionQuery<unknown>;
}) {
  return (
    <HomeWidget
      className={className}
      title="Favorites"
      icon={<Star className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      meta={favorites.length > 0 ? <HomeWidgetCount>{favorites.length}</HomeWidgetCount> : null}
    >
      <SectionBody query={state} what="favorites">
        {favorites.length === 0 ? (
          state.isLoading ? null : (
            <HomeWidgetEmpty>
              Nothing starred yet. Star a use case in Sessions, or a page, workflow, schedule or
              file, and it shows here.
            </HomeWidgetEmpty>
          )
        ) : (
          <ul className="divide-y divide-border-subtle">
            {favorites.map((favorite) => (
              <li key={`${favorite.itemType}:${favorite.itemId}`}>
                <FavoriteRow favorite={favorite} />
              </li>
            ))}
          </ul>
        )}
      </SectionBody>
    </HomeWidget>
  );
}

function FavoriteRow({ favorite }: { favorite: UserFavorite }) {
  switch (favorite.itemType) {
    case "key":
      return <KeyRow id={favorite.itemId} />;
    case "page":
      return <PageRow id={favorite.itemId} />;
    case "workflow":
      return <WorkflowRow id={favorite.itemId} />;
    case "schedule":
      return <ScheduleRow id={favorite.itemId} />;
    case "agent-fs-path":
      return <PathRow id={favorite.itemId} />;
  }
}

/** A starred use case. Its group can be gone (deleted, or only schedules and pages left). */
function KeyRow({ id }: { id: string }) {
  const { userId } = useCurrentUser();
  const { data: tree } = useSessionTree();
  const group = tree?.groups.find((g) => g.key === id);
  const meta = !tree ? null : group ? (
    group.running > 0 ? (
      <>
        <TaskStatusIcon status="in_progress" className="size-3.5" />
        {group.running} running
      </>
    ) : (
      `${group.total} ${group.total === 1 ? "session" : "sessions"}`
    )
  ) : (
    "No sessions"
  );
  return (
    <Row
      icon={FolderOpen}
      title={groupLabel(id, userId ?? null, tree?.labels) || id}
      meta={meta}
      kind={favoriteKind("key", id)}
      to={favoriteHref("key", id)}
    />
  );
}

function PageRow({ id }: { id: string }) {
  const { data, isError } = usePage(id);
  return (
    <Row
      icon={Globe}
      title={data?.title || (isError ? "Page not found" : "Page")}
      muted={isError}
      meta={data ? `Updated ${formatRelativeTime(data.updatedAt)}` : null}
      kind={favoriteKind("page", id)}
      to={favoriteHref("page", id)}
    />
  );
}

function WorkflowRow({ id }: { id: string }) {
  const { data, isError } = useWorkflow(id);
  return (
    <Row
      icon={Workflow}
      title={data?.name || (isError ? "Workflow not found" : "Workflow")}
      muted={isError}
      meta={
        data ? (data.enabled ? `Updated ${formatRelativeTime(data.lastUpdatedAt)}` : "Off") : null
      }
      kind={favoriteKind("workflow", id)}
      to={favoriteHref("workflow", id)}
    />
  );
}

function ScheduleRow({ id }: { id: string }) {
  const { data, isError } = useScheduledTask(id);
  return (
    <Row
      icon={Clock}
      title={data?.name || (isError ? "Schedule not found" : "Schedule")}
      muted={isError}
      meta={
        data
          ? data.enabled && data.nextRunAt
            ? `Next ${formatSmartTime(data.nextRunAt)}`
            : "Paused"
          : null
      }
      kind={favoriteKind("schedule", id)}
      to={favoriteHref("schedule", id)}
    />
  );
}

/** An agent-fs pin id is `<org>/<drive>/<path>`: show the path. */
function PathRow({ id }: { id: string }) {
  const path = id.split("/").slice(2).join("/");
  const folder = path.endsWith("/");
  return (
    <Row
      icon={folder ? FolderOpen : File}
      title={path || id}
      mono
      kind={favoriteKind("agent-fs-path", id)}
      to={favoriteHref("agent-fs-path", id)}
    />
  );
}

function Row({
  icon: Icon,
  title,
  meta,
  kind,
  to,
  mono = false,
  muted = false,
}: {
  icon: LucideIcon;
  title: string;
  meta?: ReactNode;
  kind: string;
  to: string | null;
  mono?: boolean;
  muted?: boolean;
}) {
  const body = (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          mono ? "font-mono text-[13px]" : "text-sm",
          muted && "text-muted-foreground",
        )}
      >
        {title}
      </span>
      {meta ? (
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
          {meta}
        </span>
      ) : null}
      <span className="w-16 shrink-0 text-xs text-muted-foreground max-sm:hidden">{kind}</span>
    </>
  );
  const className = "flex h-12 items-center gap-3 px-4";
  if (!to) return <div className={className}>{body}</div>;
  return (
    <Link
      to={to}
      className={cn(
        className,
        "outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
      )}
    >
      {body}
    </Link>
  );
}
