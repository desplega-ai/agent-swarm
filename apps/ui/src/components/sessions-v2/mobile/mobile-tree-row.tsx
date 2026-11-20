/**
 * The sidebar rows on a phone (SPEC R8.5, UX review R9): the same row model
 * as the desktop tree (`tree-rows.ts`), drawn for touch. Rows are at least
 * 44 px. A session row is one 48 px line: a chat source logo, the title,
 * the people, and the time. It takes a second line (56 px) only for more to
 * say: its group in a flat list, or when it comes back from Later. A group
 * name shows before its counts: the counts get shorter when the name does not fit.
 * There are no tooltips, no hover card, no key hints, and no drag. Rows sit
 * on two columns (marks and icons, then titles and names): a session uses
 * the columns of its group, and a subgroup takes one indent step, with no
 * guide lines.
 *
 * Touch: tap a session to open it, swipe it left for Done and right for
 * Later (the action color shows behind it), and long-press it to start a
 * selection. While a selection is on, a tap selects. A long-press on one of
 * my groups opens its sheet. A tap on a group or a source header folds it.
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
import {
  type CSSProperties,
  type MouseEvent,
  memo,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { SessionListItem, SessionSectionCounts } from "@/api/types";
import { AvatarStack } from "@/components/comb/presence-avatars";
import { TaskSourceMark } from "@/components/shared/task-source-mark";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useLongPress } from "@/hooks/use-long-press";
import { type SwipeSide, useSwipeRow } from "@/hooks/use-swipe-row";
import { peerColor } from "@/lib/comb/presence";
import { chatSourceOf, groupLabel } from "@/lib/session-groups";
import { showsUnread } from "@/lib/session-status";
import { cn, sessionDisplayTitle } from "@/lib/utils";
import { type ContainerRow, containerFacts, GroupNameField, RowIcon } from "../sidebar/group-node";
import { type SourceRow, sourceRowLabel } from "../sidebar/section-header";
import {
  ActivityMark,
  activityOf,
  MatchedTitle,
  othersOf,
  rowLabel,
  shortAgo,
} from "../sidebar/session-row";
import { formatWakeShort } from "../sidebar/snooze-times";
import {
  NeedsYouBadge,
  ReadMark,
  rowPropsEqual,
  TREE_CURSOR_CLASS,
  UNREAD_TITLE,
} from "../sidebar/tree-row";

/** One indent step at most (UX review R9): 16 px, or 28 px nested. */
function indent(level: number): CSSProperties {
  return { paddingLeft: `${16 + Math.min(Math.max(level, 0), 1) * 12}px` };
}

/**
 * The indent of a row inside a container (a session, "Show 10 more", "View
 * all N"): the container's own, so the row's title sits under its name.
 */
const indentIn = (level: number) => indent(level - 1);

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
  cursor?: boolean;
  level: number;
  flat: boolean;
  me: string | null;
  now: number;
  /** The source group labels of the tree (`#eng`), for the group label of a flat row. */
  labels: Readonly<Record<string, string>>;
  /** The group whose list this row is in (the group screen): its name does not repeat on the row. */
  listGroup?: string;
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
  cursor,
  level,
  flat,
  me,
  now,
  labels,
  listGroup,
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
  const unread = showsUnread(session);
  const wake = session.readState === "later" ? session.snoozeUntil : null;
  const activity = activityOf(session);
  const group = flat ? groupLabel(session.groupKey, me, labels) : "";
  const chat = chatSourceOf(session.root);
  const others = othersOf(session, me);
  const nowDate = new Date(now);
  const behind = swipe.side ? swipeAction(session, swipe.side) : null;
  const BehindIcon = behind?.icon;
  const label = rowLabel(session, me, title, group, nowDate);
  // The second line: the group (not the list's own), and when a Later session comes back.
  const more = [
    session.groupKey === listGroup ? "" : group,
    wake ? `Back ${formatWakeShort(wake, nowDate)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
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
        data-cursor={cursor ? "true" : undefined}
        style={{ ...(flat ? indent(0) : indentIn(level)), ...swipe.style }}
        className={cn(
          // Press feedback, as on the container rows (UX review R9).
          "relative flex items-center gap-3 py-2 pr-4 active:bg-accent",
          more ? "min-h-14" : "min-h-12",
          // The row covers the swipe action: the list card's fill on the group screen.
          as === "list" ? "bg-card" : "bg-background",
          selected && "bg-accent",
          TREE_CURSOR_CLASS,
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
            {chat ? (
              <TaskSourceMark source={chat} className="size-3.5 text-muted-foreground" />
            ) : null}
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
              <Users aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            ) : null}
            {wake ? null : (
              <span className="shrink-0 font-mono text-data tabular-nums text-muted-foreground">
                {shortAgo(session.lastActivityAt, now)}
              </span>
            )}
          </span>
          {more ? (
            <span
              className={cn(
                "min-w-0 truncate text-data text-muted-foreground",
                // Under the title, not under the source logo (14 px and the 8 px gap).
                chat && "pl-5.5",
              )}
            >
              {more}
            </span>
          ) : null}
        </span>
      </div>
    </Root>
  );
}

export const MobileSessionRow = memo(MobileSessionRowView, rowPropsEqual);

interface MobileContainerRowProps {
  row: ContainerRow;
  domId: string;
  cursor: boolean;
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
  cursor,
  ownerName,
  describedBy,
  onRowClick,
  onLongPress,
  renaming,
  onRenameDone,
}: MobileContainerRowProps) {
  const press = useLongPress(onLongPress ? () => onLongPress(row.key) : undefined);
  const { name, searchMatch, hasChildren, plain, label } = containerFacts(row, ownerName);
  const nameRef = useRef<HTMLSpanElement>(null);

  return (
    <div
      id={domId}
      role="treeitem"
      tabIndex={-1}
      data-cursor={cursor ? "true" : undefined}
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
        TREE_CURSOR_CLASS,
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
          ref={nameRef}
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
      {row.counts && !renaming ? (
        <TouchCounts counts={row.counts} plain={plain} name={name} nameRef={nameRef} />
      ) : null}
    </div>
  );
}

export const MobileContainerRow = memo(MobileContainerRowView, rowPropsEqual);

/**
 * The counts of a container row on a phone. They never shrink: the name
 * takes the rest of the row. They show in full while the name fits. If it
 * does not, the running count goes first, then "N unread" turns into a dot.
 * "N need you" always stays, and a name that is still too long is cut.
 */
function TouchCounts({
  counts,
  plain,
  name,
  nameRef,
}: {
  counts: SessionSectionCounts;
  plain?: boolean;
  /** The row's name: a new name measures again. */
  name: string;
  nameRef: RefObject<HTMLSpanElement | null>;
}) {
  // 0: all. 1: no running count. 2: also the unread dot.
  const [fit, setFit] = useState({ level: 0, width: 0 });
  const what = `${name} ${counts.running} ${counts.needsYou} ${counts.unread} ${counts.total}`;
  // A new row width, a new name, or new counts: measure again from the full form.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `what` restarts the measure
  useLayoutEffect(() => {
    const row = nameRef.current?.parentElement;
    if (!row) return;
    setFit({ level: 0, width: row.clientWidth });
    const observer = new ResizeObserver(() =>
      setFit((prev) =>
        prev.width === row.clientWidth ? prev : { level: 0, width: row.clientWidth },
      ),
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, [what, nameRef]);
  // One step shorter while the name is cut (1 px of slack for rounding).
  useLayoutEffect(() => {
    const label = nameRef.current;
    if (fit.level >= 2 || !label) return;
    if (label.scrollWidth > label.clientWidth + 1) setFit({ ...fit, level: fit.level + 1 });
  }, [fit, nameRef]);

  const number = "font-mono text-data tabular-nums text-muted-foreground";
  const showTotal = plain && counts.running === 0 && counts.needsYou === 0 && counts.unread === 0;
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-1.5">
      {counts.running > 0 && fit.level < 1 ? (
        <span className={cn("flex shrink-0 items-center gap-1", number)}>
          <TaskStatusIcon variant="active" className="size-3.5" />
          {counts.running}
        </span>
      ) : null}
      {counts.needsYou > 0 ? (
        <NeedsYouBadge>
          {counts.needsYou} {counts.needsYou === 1 ? "needs" : "need"} you
        </NeedsYouBadge>
      ) : null}
      {counts.unread > 0 ? (
        fit.level < 2 ? (
          <Badge
            variant="outline"
            className="h-5 rounded-sm bg-background px-1.5 text-meta font-semibold tabular-nums"
          >
            {counts.unread} unread
          </Badge>
        ) : (
          <ReadMark unread className="size-2" />
        )
      ) : null}
      {showTotal ? <span className={number}>{counts.total}</span> : null}
    </span>
  );
}

/**
 * A source section header on a phone: the section header look (logo, name,
 * count) in a 44 px row. A tap folds the section.
 */
function MobileSourceRowView({
  row,
  domId,
  cursor,
  onRowClick,
}: {
  row: SourceRow;
  domId: string;
  cursor: boolean;
  onRowClick: (rowKey: string, event: MouseEvent) => void;
}) {
  return (
    <div
      id={domId}
      role="treeitem"
      tabIndex={-1}
      data-cursor={cursor ? "true" : undefined}
      aria-level={1}
      aria-expanded={row.open}
      aria-label={sourceRowLabel(row)}
      onClick={(event) => onRowClick(row.key, event)}
      className={cn(
        // The logo sits in the rows' icon column, and the name in their label column.
        "mx-1.5 mt-3 flex min-h-11 items-center gap-3 rounded-sm pr-2.5 pl-2.5 font-mono text-meta text-muted-foreground active:bg-accent",
        TOUCH_ROW,
        TREE_CURSOR_CLASS,
      )}
    >
      <span className="grid size-5 shrink-0 place-items-center">
        <TaskSourceMark source={row.source} />
      </span>
      <span className="min-w-0 flex-1 truncate tracking-widest uppercase">{row.label}</span>
      <span className="shrink-0 tabular-nums">{row.counts.total}</span>
    </div>
  );
}

export const MobileSourceRow = memo(MobileSourceRowView, rowPropsEqual);

/** "Show 10 more", "View all N" (a chevron: it pushes a screen), and "New group". */
export function MobileActionRow({
  id,
  cursor,
  level,
  kind,
  label,
  onClick,
}: {
  id: string;
  cursor: boolean;
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
      data-cursor={cursor ? "true" : undefined}
      aria-level={level + 1}
      onClick={onClick}
      // "New group" is a row of its level. The others end a container's list.
      style={kind === "add" ? indent(level) : indentIn(level)}
      className={cn(
        "flex min-h-12 items-center gap-3 pr-4 text-base font-medium text-muted-foreground active:bg-accent",
        TOUCH_ROW,
        TREE_CURSOR_CLASS,
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
