/**
 * The sidebar rows on a phone (SPEC R8.5, UX review R9): the same row model
 * as the desktop tree (`tree-rows.ts`), drawn for touch. Rows are at least
 * 44 px, session rows 56 px with two lines (the title, then the group, the
 * time, and the people). Counts always show. There are no tooltips, no
 * hover card, no key hints, and no drag. Flat lists sit at the left edge
 * and nested rows take one indent step, with no guide lines.
 *
 * Touch: tap a session to open it, swipe it left for Done and right for
 * Later (the action color shows behind it), and long-press it to start a
 * selection. While a selection is on, a tap selects. A long-press on one of
 * my groups opens its sheet. A tap on a group folds it.
 */

import {
  AlarmClock,
  Archive,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Hash,
  Inbox,
  Users,
} from "lucide-react";
import { type CSSProperties, type MouseEvent, memo, type ReactNode } from "react";
import type { SessionListItem } from "@/api/types";
import { AvatarStack } from "@/components/comb/presence-avatars";
import { Checkbox } from "@/components/ui/checkbox";
import { useLongPress } from "@/hooks/use-long-press";
import { type SwipeSide, useSwipeRow } from "@/hooks/use-swipe-row";
import { peerColor } from "@/lib/comb/presence";
import { groupLabel } from "@/lib/session-groups";
import { cn, sessionDisplayTitle } from "@/lib/utils";
import {
  type ContainerRow,
  containerFacts,
  GroupNameField,
  RowIcon,
  SessionCounts,
} from "../sidebar/group-node";
import {
  ActivityMark,
  activityOf,
  MatchedTitle,
  othersOf,
  rowLabel,
  shortAgo,
} from "../sidebar/session-row";
import { formatWakeShort } from "../sidebar/snooze-times";
import { ReadMark, rowPropsEqual, UNREAD_TITLE } from "../sidebar/tree-row";

/** One indent step at most (UX review R9): 16 px, or 28 px nested. */
function indent(level: number): CSSProperties {
  return { paddingLeft: `${16 + Math.min(level, 1) * 12}px` };
}

/** No callout, no text selection, and the browser keeps vertical pans. */
const TOUCH_ROW = "select-none outline-none [-webkit-touch-callout:none] touch-pan-y";

/** The action that shows behind a swiped row. A session already there goes back to the Inbox. */
function swipeAction(session: SessionListItem, side: SwipeSide) {
  if (side === "left") {
    return session.readState === "done"
      ? { icon: Inbox, label: "Inbox" }
      : { icon: Archive, label: "Done" };
  }
  return session.readState === "later"
    ? { icon: Inbox, label: "Inbox" }
    : { icon: AlarmClock, label: "Later" };
}

interface MobileSessionRowProps {
  rowKey: string;
  session: SessionListItem;
  domId: string;
  level: number;
  flat: boolean;
  me: string | null;
  now: number;
  selected: boolean;
  /** A selection is on: a tap selects, and swipes are off. */
  selecting: boolean;
  /** Swipes need a picked user (Done and Later). */
  canTriage: boolean;
  highlight?: readonly string[];
  /** `tree`: a tree item (the list screen). `list`: a list item (the group screen). */
  as?: "tree" | "list";
  onRowClick: (rowKey: string, event: MouseEvent) => void;
  onSwipe: (rowKey: string, side: SwipeSide) => void;
  onLongPress: (rowKey: string) => void;
}

function MobileSessionRowView({
  rowKey,
  session,
  domId,
  level,
  flat,
  me,
  now,
  selected,
  selecting,
  canTriage,
  highlight,
  as = "tree",
  onRowClick,
  onSwipe,
  onLongPress,
}: MobileSessionRowProps) {
  const swipe = useSwipeRow({
    enabled: canTriage && !selecting,
    onSwipe: (side) => onSwipe(rowKey, side),
  });
  // A long-press starts a selection: a sideways drag after it is no swipe.
  const press = useLongPress(() => {
    swipe.cancel();
    onLongPress(rowKey);
  });
  const title = sessionDisplayTitle(session.root);
  const unread = session.readState === "unread";
  const wake = session.readState === "later" ? session.snoozeUntil : null;
  const activity = activityOf(session);
  const group = flat ? groupLabel(session.groupKey, me) : "";
  const others = othersOf(session, me);
  const nowDate = new Date(now);
  const behind = swipe.side ? swipeAction(session, swipe.side) : null;
  const BehindIcon = behind?.icon;
  const label = rowLabel(session, me, title, group, nowDate);
  const Root = as === "list" ? "li" : "div";

  return (
    <Root
      id={domId}
      data-session-id={session.root.id}
      {...(as === "tree"
        ? { role: "treeitem", "aria-level": level + 1, "aria-selected": selected }
        : {})}
      tabIndex={-1}
      // A list item has no selected state: the name says it.
      aria-label={as === "list" && selected ? `Selected. ${label}` : label}
      onClick={(event) => onRowClick(rowKey, event)}
      onClickCapture={(event) => {
        swipe.handlers.onClickCapture(event);
        press.onClickCapture(event);
      }}
      onPointerDown={(event) => {
        swipe.handlers.onPointerDown(event);
        press.onPointerDown(event);
      }}
      onPointerMove={(event) => {
        swipe.handlers.onPointerMove(event);
        press.onPointerMove(event);
      }}
      onPointerUp={(event) => {
        swipe.handlers.onPointerUp(event);
        press.onPointerUp();
      }}
      onPointerCancel={(event) => {
        swipe.handlers.onPointerCancel(event);
        press.onPointerCancel();
      }}
      onContextMenu={press.onContextMenu}
      className={cn("relative overflow-hidden", TOUCH_ROW)}
    >
      {behind && BehindIcon ? (
        <div
          aria-hidden
          className={cn(
            "absolute inset-0 flex items-center px-6 text-sm font-semibold",
            swipe.side === "left" ? "justify-end" : "justify-start",
            !swipe.armed
              ? "bg-muted text-muted-foreground"
              : swipe.side === "left"
                ? "bg-status-success text-status-success-foreground"
                : "bg-primary text-primary-foreground",
          )}
        >
          <span
            className={cn("flex items-center gap-2", swipe.side === "left" && "flex-row-reverse")}
          >
            <BehindIcon
              className={cn(
                "size-5 transition-transform duration-150 ease-snappy",
                swipe.armed && "scale-115",
              )}
            />
            {behind.label}
          </span>
        </div>
      ) : null}
      <div
        style={{ ...indent(flat ? 0 : level), ...swipe.style }}
        className={cn(
          // Press feedback, as on the container rows (UX review R9).
          "relative flex min-h-14 items-center gap-3 py-2 pr-4 active:bg-accent",
          // The row covers the swipe action: the list card's fill on the group screen.
          as === "list" ? "bg-card" : "bg-background",
          selected && "bg-accent",
        )}
      >
        <span className="grid size-5 shrink-0 place-items-center">
          {selecting ? (
            // The row is the control while selecting: the box only shows the state.
            <Checkbox
              tabIndex={-1}
              aria-hidden
              checked={selected}
              className="pointer-events-none"
            />
          ) : (
            <ReadMark unread={unread} className="size-2" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-base",
                unread ? UNREAD_TITLE : "text-foreground/80",
              )}
            >
              <MatchedTitle title={title} words={highlight} />
            </span>
            {activity ? (
              <span className="flex shrink-0 items-center">
                <ActivityMark activity={activity} />
              </span>
            ) : null}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-data text-muted-foreground">
            <span className="min-w-0 truncate">
              {[
                group,
                wake
                  ? `Back ${formatWakeShort(wake, nowDate)}`
                  : shortAgo(session.lastActivityAt, now),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span className="min-w-0 flex-1" />
            {others.length > 0 ? (
              <AvatarStack
                decorative
                size="sm"
                max={2}
                // 24 px avatars with 11 px initials (UX review R9). The Avatar
                // primitive's sm size would set 12 px, so this one is marked important.
                className="[&_[data-slot=avatar-fallback]]:text-meta!"
                peers={others.map((person) => ({
                  id: person.id,
                  name: person.name,
                  color: peerColor(person.id),
                  doing: "",
                }))}
              />
            ) : session.shared ? (
              <Users aria-hidden className="size-3.5 shrink-0" />
            ) : null}
          </span>
        </span>
      </div>
    </Root>
  );
}

export const MobileSessionRow = memo(MobileSessionRowView, rowPropsEqual);

interface MobileContainerRowProps {
  row: ContainerRow;
  domId: string;
  ownerName?: string;
  describedBy?: string;
  onRowClick: (rowKey: string, event: MouseEvent) => void;
  /** A long-press: the group sheet. Missing on rows with none. */
  onLongPress?: (rowKey: string) => void;
  renaming?: boolean;
  onRenameDone?: (groupKey: string, name: string | null) => void;
}

function MobileContainerRowView({
  row,
  domId,
  ownerName,
  describedBy,
  onRowClick,
  onLongPress,
  renaming,
  onRenameDone,
}: MobileContainerRowProps) {
  const press = useLongPress(onLongPress ? () => onLongPress(row.key) : undefined);
  const { name, searchMatch, hasChildren, plain, label } = containerFacts(row, ownerName);

  return (
    <div
      id={domId}
      role="treeitem"
      tabIndex={-1}
      aria-level={row.level + 1}
      aria-expanded={searchMatch ? undefined : row.open}
      aria-label={label}
      aria-describedby={describedBy}
      onClick={(event) => onRowClick(row.key, event)}
      onClickCapture={press.onClickCapture}
      onPointerDown={press.onPointerDown}
      onPointerMove={press.onPointerMove}
      onPointerUp={press.onPointerUp}
      onPointerCancel={press.onPointerCancel}
      onContextMenu={press.onContextMenu}
      style={indent(row.level)}
      className={cn(
        "flex min-h-12 items-center gap-3 pr-4 active:bg-accent",
        TOUCH_ROW,
        row.level === 0 && "mt-1",
      )}
    >
      <span className="grid size-5 shrink-0 place-items-center">
        <RowIcon row={row} ownerName={ownerName} touch />
      </span>
      {renaming && row.type === "group" ? (
        <GroupNameField
          initial={row.node.name}
          label="Rename group"
          onDone={(next) => onRenameDone?.(row.node.key, next)}
          className="h-11 text-base md:text-base"
        />
      ) : (
        <span
          className={cn(
            "min-w-0 truncate text-base",
            row.type === "box" ? "font-semibold" : "font-medium",
            row.type === "group" && !row.node.name && "text-muted-foreground",
          )}
        >
          {name}
        </span>
      )}
      {hasChildren ? (
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-snappy",
            !row.open && "-rotate-90",
          )}
        />
      ) : null}
      {/* The rename field takes the free room itself. */}
      {renaming ? null : <span className="min-w-0 flex-1" />}
      {row.counts ? <SessionCounts counts={row.counts} plain={plain} touch /> : null}
    </div>
  );
}

export const MobileContainerRow = memo(MobileContainerRowView, rowPropsEqual);

/** "Show 10 more", "View all N" (a chevron: it pushes a screen), and "New group". */
export function MobileActionRow({
  id,
  level,
  kind,
  label,
  onClick,
}: {
  id: string;
  level: number;
  kind: "more" | "all" | "add";
  label: ReactNode;
  onClick: (event: MouseEvent) => void;
}) {
  const Icon = kind === "more" ? ChevronDown : kind === "all" ? ChevronRight : FolderPlus;
  return (
    <div
      id={id}
      role="treeitem"
      tabIndex={-1}
      aria-level={level + 1}
      onClick={onClick}
      style={indent(level)}
      className={cn(
        "flex min-h-12 items-center gap-3 pr-4 text-base font-medium text-muted-foreground active:bg-accent",
        TOUCH_ROW,
      )}
    >
      {kind === "add" ? (
        <span className="grid size-5 shrink-0 place-items-center">
          <Icon aria-hidden className="size-4" />
        </span>
      ) : (
        <span aria-hidden className="size-5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {kind === "add" ? null : <Icon aria-hidden className="size-4 shrink-0" />}
    </div>
  );
}

/** The name field of a new group, where its row will be. */
export function MobileCreateRow({
  level,
  subgroup,
  onDone,
}: {
  level: number;
  subgroup: boolean;
  onDone: (name: string | null) => void;
}) {
  return (
    <div role="none" style={indent(level)} className="flex min-h-12 items-center gap-3 pr-4">
      <span className="grid size-5 shrink-0 place-items-center">
        <Hash aria-hidden className="size-4 text-muted-foreground" />
      </span>
      <GroupNameField
        label={subgroup ? "New subgroup name" : "New group name"}
        onDone={onDone}
        className="h-10 text-base md:text-base"
      />
    </div>
  );
}
