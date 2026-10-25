/**
 * One session in the sidebar (SPEC R4, R5, R9, R10.3): the unread dot (a
 * checkbox on hover), the logo of a chat source (Slack, Telegram, Discord,
 * chat), the title on one line, the group label in flat lists, the people,
 * a still activity mark, and the time. A hover card shows the full title
 * and the latest output.
 */

import { AlarmClock, FolderInput, Users } from "lucide-react";
import { type MouseEvent, memo, useState } from "react";
import type { SessionListItem } from "@/api/types";
import { AvatarStack } from "@/components/comb/presence-avatars";
import { StatusBadge } from "@/components/shared/status-badge";
import { TaskSourceMark, taskSourceLabel } from "@/components/shared/task-source-mark";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { peerColor } from "@/lib/comb/presence";
import { chatSourceOf, groupCrumb, groupLabel, isNoGroupKey } from "@/lib/session-groups";
import { splitMatches } from "@/lib/session-search";
import { sessionChipStatus } from "@/lib/session-status";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { cn, formatRelativeTime, parseUTCDate, sessionDisplayTitle } from "@/lib/utils";
import { GroupCrumbIcon } from "../group-crumb-icon";
import { formatWakeShort, wakePhrase } from "./snooze-times";
import {
  keepTreeFocus,
  NeedsYouBadge,
  ReadMark,
  rowPropsEqual,
  TipKey,
  TreeRow,
  UNREAD_TITLE,
} from "./tree-row";
import { useRowDraggable } from "./use-row-drag";

export type Activity = "needs" | "running" | "failed" | null;

/** The activity slot: Needs you, else running (the server's rule: the latest status is not terminal), else failed. */
export function activityOf(session: SessionListItem): Activity {
  if (session.needsYou) return "needs";
  if (!TERMINAL_STATUSES.has(session.latestStatus)) return "running";
  if (session.latestStatus === "failed") return "failed";
  return null;
}

/** The activity mark of a row. Running turns slowly, as everywhere (Taras, 2026-10-22). */
export function ActivityMark({ activity }: { activity: Activity }) {
  if (activity === "needs") return <NeedsYouBadge>Needs you</NeedsYouBadge>;
  if (activity === "running") {
    return <TaskStatusIcon variant="active" label="Running" className="size-3.5" />;
  }
  if (activity === "failed") {
    return <TaskStatusIcon status="failed" label="Failed" className="size-3.5" />;
  }
  return null;
}

/** A title with the search words marked (search results), else the plain title. */
export function MatchedTitle({ title, words }: { title: string; words?: readonly string[] }) {
  if (!words?.length) return title;
  return splitMatches(title, words).map((piece, i) =>
    piece.match ? (
      <mark key={i} className="rounded-xs bg-primary/25 text-inherit">
        {piece.text}
      </mark>
    ) : (
      piece.text
    ),
  );
}

/** "now", "4m", "2h", "3d", "Oct 2": the time column of a row. */
export function shortAgo(iso: string, now: number): string {
  const date = parseUTCDate(iso);
  const minutes = Math.floor((now - date.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString("en", { month: "short", day: "numeric" });
}

/** The people on a row other than me. With no picked user, everyone. */
export function othersOf(session: SessionListItem, me: string | null) {
  return (session.people ?? []).filter((person) => person.id !== me);
}

/** "With Lena, Marco" (and "+N more" past the 8 the server lists), or "Only you". */
function withText(session: SessionListItem, me: string | null): string {
  const people = session.people ?? [];
  if (people.length === 0) return "";
  if (othersOf(session, me).length === 0) return "Only you";
  const names = people.map((person) => (person.id === me ? "you" : person.name));
  const extra = (session.peopleCount ?? people.length) - people.length;
  return `With ${names.join(", ")}${extra > 0 ? ` +${extra} more` : ""}`;
}

/** "Shared with Lena (can edit), everyone (can view)", or "" when not shared (UX review R9). */
function sharedText(session: SessionListItem, me: string | null): string {
  if (!session.shared) return "";
  if (!session.shares?.length) return "Shared";
  const who = session.shares.map((share) => {
    const name = share.userId === null ? "everyone" : share.userId === me ? "you" : share.name;
    return `${name ?? "someone"} (${share.access === "write" ? "can edit" : "can view"})`;
  });
  return `Shared with ${who.join(", ")}`;
}

/** The row's accessible name: state, title, chat source, group, people, sharing, and time. */
export function rowLabel(
  session: SessionListItem,
  me: string | null,
  title: string,
  group: string,
  now: Date,
): string {
  const activity = activityOf(session);
  const wake = session.readState === "later" && session.snoozeUntil;
  const chat = chatSourceOf(session.root);
  return [
    session.readState === "unread" && "Unread",
    activity === "needs" && "Needs you",
    !TERMINAL_STATUSES.has(session.latestStatus) && "Running",
    session.latestStatus === "failed" && "Failed",
    title,
    chat && `From ${taskSourceLabel(chat)}`,
    group && `In ${group}`,
    othersOf(session, me).length > 0 && withText(session, me),
    sharedText(session, me),
    wake ? `Wakes ${wakePhrase(wake, now)}` : formatRelativeTime(session.lastActivityAt),
  ]
    .filter(Boolean)
    .join(". ");
}

function SessionCard({
  session,
  me,
  title,
  nameOf,
  labels,
}: {
  session: SessionListItem;
  me: string | null;
  title: string;
  nameOf: (userId: string) => string;
  labels: Readonly<Record<string, string>>;
}) {
  const noGroup = !session.groupKey || isNoGroupKey(session.groupKey, me);
  const people = withText(session, me);
  const shared = sharedText(session, me);
  const wake = session.readState === "later" ? session.snoozeUntil : null;
  return (
    <>
      <p className="flex min-w-0 items-center gap-1 text-meta text-muted-foreground">
        <GroupCrumbIcon groupKey={session.groupKey} noGroup={noGroup} className="size-3" />
        <span className="truncate">{groupCrumb(session.groupKey, me, nameOf, labels)}</span>
      </p>
      <p className="mt-1 text-sm font-medium break-words">{title}</p>
      {session.preview ? (
        <p className="mt-1 line-clamp-3 text-xs break-words text-muted-foreground">
          {session.preview}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
        {session.needsYou ? (
          <NeedsYouBadge>Needs you</NeedsYouBadge>
        ) : (
          <StatusBadge status={sessionChipStatus(session.latestStatus)} />
        )}
        {session.readState === "unread" ? (
          <Badge variant="outline" size="tag">
            Unread
          </Badge>
        ) : null}
        <span className="font-mono tabular-nums">
          {session.chainTaskCount} {session.chainTaskCount === 1 ? "task" : "tasks"}
        </span>
        <span>
          {wake
            ? `Back in your Inbox ${wakePhrase(wake, new Date())}`
            : formatRelativeTime(session.lastActivityAt)}
        </span>
        {people ? <span>{people}</span> : null}
        {shared ? <span>{shared}</span> : null}
      </div>
    </>
  );
}

interface SessionRowProps {
  rowKey: string;
  session: SessionListItem;
  domId: string;
  level: number;
  /** Inbox, Later, and Done: name the group in a muted label. */
  flat: boolean;
  me: string | null;
  /** The minute clock (ms): row times stay true without a poll. */
  now: number;
  /** Shown in the focused pane. */
  open: boolean;
  /** The keyboard cursor. */
  cursor: boolean;
  selected: boolean;
  /** Show the checkbox in the left slot (selection mode, or the keyboard cursor). */
  showCheckbox: boolean;
  /** Search words to mark in the title (search results only). */
  highlight?: readonly string[];
  /** The keyboard cursor rests here: open the hover card. */
  peek: boolean;
  /** Keys drive the list: only the cursor's card opens, and with no motion. */
  keyboard: boolean;
  nameOf: (userId: string) => string;
  /** The source group labels of the tree (`#eng`), for the group label and the card. */
  labels: Readonly<Record<string, string>>;
  onRowClick: (rowKey: string, event: MouseEvent) => void;
  onRowAuxClick: (rowKey: string, event: MouseEvent) => void;
  onRowContextMenu: (rowKey: string, event: MouseEvent) => void;
  /**
   * The checkbox: select or unselect this row (the tree also puts its cursor
   * and focus here). `range`: Shift+click, select up to this row.
   */
  onToggleSelect: (rowKey: string, range?: boolean) => void;
  /** The keyboard card closed itself (Escape). */
  onPeekClose: () => void;
}

function SessionRowView({
  rowKey,
  session,
  domId,
  level,
  flat,
  me,
  now,
  open,
  cursor,
  selected,
  showCheckbox,
  highlight,
  peek,
  keyboard,
  nameOf,
  labels,
  onRowClick,
  onRowAuxClick,
  onRowContextMenu,
  onToggleSelect,
  onPeekClose,
}: SessionRowProps) {
  const [hover, setHover] = useState(false);
  // Drag onto a group to move it (plan Phase 5).
  const { dragRef, dragListeners, isDragging } = useRowDraggable(rowKey, session);
  const title = sessionDisplayTitle(session.root);
  const unread = session.readState === "unread";
  const wake = session.readState === "later" ? session.snoozeUntil : null;
  const activity = activityOf(session);
  const group = flat ? groupLabel(session.groupKey, me, labels) : "";
  const chat = chatSourceOf(session.root);
  const others = othersOf(session, me);
  const nowDate = new Date(now);

  return (
    <HoverCard
      openDelay={400}
      closeDelay={100}
      open={keyboard ? peek : hover && !isDragging}
      onOpenChange={(next) => {
        setHover(next);
        if (!next && keyboard) onPeekClose();
      }}
    >
      <HoverCardTrigger asChild>
        <TreeRow
          ref={dragRef}
          {...dragListeners}
          id={domId}
          level={level}
          cursor={cursor}
          aria-selected={selected}
          aria-label={rowLabel(session, me, title, group, nowDate)}
          data-open={open ? "true" : undefined}
          onClick={(event) => onRowClick(rowKey, event)}
          onAuxClick={(event) => onRowAuxClick(rowKey, event)}
          onContextMenu={(event) => onRowContextMenu(rowKey, event)}
          className={cn(
            "h-[26px] text-data",
            "data-[open=true]:bg-accent data-[open=true]:[--avatar-ring:var(--color-accent)]",
            // The open session's marker sits inside the row (UX review R9).
            "data-[open=true]:after:absolute data-[open=true]:after:inset-y-1.5 data-[open=true]:after:left-0 data-[open=true]:after:w-0.5 data-[open=true]:after:rounded-full data-[open=true]:after:bg-primary",
            selected && "bg-primary/10 hover:bg-primary/15",
            isDragging && "opacity-50",
          )}
        >
          <span className="grid size-4 shrink-0 place-items-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <Checkbox
                  tabIndex={-1}
                  aria-hidden
                  checked={selected}
                  onCheckedChange={() => onToggleSelect(rowKey)}
                  onClick={(event) => {
                    event.stopPropagation();
                    // Shift: a range. preventDefault skips the plain toggle.
                    if (!event.shiftKey) return;
                    event.preventDefault();
                    onToggleSelect(rowKey, true);
                  }}
                  onMouseDown={keepTreeFocus}
                  className={cn(
                    "col-start-1 row-start-1",
                    showCheckbox || selected ? "flex" : "hidden group-hover/row:flex",
                  )}
                />
              </TooltipTrigger>
              <TooltipContent className="flex items-center gap-1.5">
                Select
                <TipKey>X</TipKey>
              </TooltipContent>
            </Tooltip>
            {unread ? (
              <ReadMark
                unread
                className={cn(
                  "col-start-1 row-start-1",
                  showCheckbox || selected ? "hidden" : "group-hover/row:hidden",
                )}
              />
            ) : null}
          </span>
          {chat ? <TaskSourceMark source={chat} className="size-3 text-muted-foreground" /> : null}
          <span
            className={cn(
              "min-w-[45%] flex-1 truncate",
              unread ? UNREAD_TITLE : "text-muted-foreground",
              open && "text-foreground",
            )}
          >
            <MatchedTitle title={title} words={highlight} />
          </span>
          {/* In the 320 px sidebar the title keeps its room: an activity mark or
              a wake time hides the group label (UX review R9). */}
          {group && !activity && !wake ? (
            <span className="max-w-16 shrink truncate text-meta text-muted-foreground">
              {group}
            </span>
          ) : null}
          {others.length > 0 ? (
            <AvatarStack
              decorative
              size="xs"
              max={1}
              peers={others.map((person) => ({
                id: person.id,
                name: person.name,
                color: peerColor(person.id),
                doing: "",
              }))}
            />
          ) : session.shared ? (
            <Users aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
          {activity ? (
            <span className="flex shrink-0 items-center">
              <ActivityMark activity={activity} />
            </span>
          ) : null}
          {wake ? (
            <span className="flex shrink-0 items-center gap-0.5 font-mono text-meta tabular-nums text-muted-foreground">
              <AlarmClock aria-hidden className="size-3" />
              {formatWakeShort(wake, nowDate)}
            </span>
          ) : (
            <span
              className={cn(
                "min-w-6 shrink-0 text-right font-mono text-meta tabular-nums",
                unread ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {shortAgo(session.lastActivityAt, now)}
            </span>
          )}
        </TreeRow>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={10}
        collisionPadding={8}
        // Opened by the keyboard cursor: no motion at all (the frequency rule).
        className={cn(
          "w-80 p-3",
          keyboard && "data-[state=closed]:animate-none data-[state=open]:animate-none",
        )}
      >
        <SessionCard session={session} me={me} title={title} nameOf={nameOf} labels={labels} />
      </HoverCardContent>
    </HoverCard>
  );
}

export const SessionRow = memo(SessionRowView, rowPropsEqual);

/** What follows the pointer while rows drag onto a group: the title, or the count. */
export function SessionDragPreview({ sessions }: { sessions: SessionListItem[] }) {
  const [only] = sessions;
  return (
    <div className="flex max-w-72 cursor-grabbing items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 py-1.5 text-data font-medium shadow-md">
      <FolderInput aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">
        {sessions.length === 1 && only
          ? sessionDisplayTitle(only.root)
          : `${sessions.length} sessions`}
      </span>
    </div>
  );
}
