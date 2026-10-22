/**
 * A container row in the sidebar: a section box (Inbox, Later, Done, No
 * group), a group, or an owner under Shared with me (SPEC R4, R5). It shows
 * its icon, its name, a chevron when it has subgroups (the one fold
 * control), the group menu "⋯" and a "+" on hover or on the keyboard
 * cursor, and the counts. The actions sit next to the counts and never
 * cover them. My groups and No group take dropped rows (plan Phase 5).
 */

import {
  AlarmClock,
  Archive,
  ChevronDown,
  Ellipsis,
  Hash,
  Inbox,
  Lock,
  type LucideIcon,
  Plus,
  SquareDashed,
} from "lucide-react";
import { type KeyboardEvent, type MouseEvent, memo, type ReactNode, useRef, useState } from "react";
import type { SessionSectionCounts } from "@/api/types";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SessionSection } from "@/lib/sessions-v2";
import { cn } from "@/lib/utils";
import {
  keepTreeFocus,
  NeedsYouBadge,
  NO_KEYBOARD_MOTION,
  rowPropsEqual,
  TipKey,
  TreeRow,
} from "./tree-row";
import type { TreeRow as TreeRowModel } from "./tree-rows";
import { useGroupDroppable } from "./use-row-drag";

export const SECTION_META: Record<SessionSection, { label: string; icon: LucideIcon }> = {
  inbox: { label: "Inbox", icon: Inbox },
  later: { label: "Later", icon: AlarmClock },
  done: { label: "Done", icon: Archive },
  nogroup: { label: "No group", icon: SquareDashed },
};

/** "1 needs you · 2 running · 3 unread", for the counts tooltip. */
function countsTip(counts: SessionSectionCounts): string {
  return [
    counts.needsYou > 0 && `${counts.needsYou} ${counts.needsYou === 1 ? "needs" : "need"} you`,
    counts.running > 0 && `${counts.running} running`,
    counts.unread > 0 && `${counts.unread} unread`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The counts in words, for the tooltip and the row's accessible name. */
export function countsLabel(counts: SessionSectionCounts, plain?: boolean): string {
  const tip = countsTip(counts);
  if (tip || !plain || counts.total === 0) return tip;
  return `${counts.total} ${counts.total === 1 ? "session" : "sessions"}`;
}

/**
 * The counts of a container in the row words: a running ring with its
 * number, "1 needs you", "3 unread" (SPEC R4, R9). `plain` (Later, Done)
 * shows the session total when nothing else shows. The row's name already
 * says them, so they are hidden from screen readers here. `touch` (the
 * phone rows): larger text and no tooltip.
 *
 * On desktop the name has priority: in a narrow row the counts give way a
 * whole mark at a time, the running count first and "unread" last. They
 * wrap out of a one-line box (DOM order reversed under `flex-row-reverse`,
 * so the marks read left to right as usual).
 */
export function SessionCounts({
  counts,
  plain,
  touch = false,
  className,
}: {
  counts: SessionSectionCounts;
  plain?: boolean;
  touch?: boolean;
  className?: string;
}) {
  const tip = countsLabel(counts, plain);
  if (!tip) return null;
  const number = cn(
    "font-mono tabular-nums text-muted-foreground",
    touch ? "text-data" : "px-0.5 text-meta",
  );
  const items = [
    counts.running > 0 ? (
      <span key="running" className={cn("flex shrink-0 items-center gap-1", number)}>
        <TaskStatusIcon variant="active" className={touch ? "size-3.5" : "size-3"} />
        {counts.running}
      </span>
    ) : null,
    counts.needsYou > 0 ? (
      <NeedsYouBadge key="needs">
        {counts.needsYou} {counts.needsYou === 1 ? "needs" : "need"} you
      </NeedsYouBadge>
    ) : null,
    counts.unread > 0 ? (
      <Badge
        key="unread"
        variant="outline"
        className={cn(
          "rounded-sm bg-background px-1.5 text-meta font-semibold tabular-nums",
          touch ? "h-5" : "h-[18px]",
        )}
      >
        {counts.unread} unread
      </Badge>
    ) : null,
    plain && !countsTip(counts) ? (
      <span key="total" className={number}>
        {counts.total}
      </span>
    ) : null,
  ];
  if (touch) {
    return (
      <span aria-hidden className={cn("ml-auto flex shrink-0 items-center gap-1.5", className)}>
        {items}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-hidden
          className={cn(
            "flex h-[18px] min-w-0 flex-row-reverse flex-wrap items-center gap-1 overflow-hidden",
            className,
          )}
        >
          {items.reverse()}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{tip}</TooltipContent>
    </Tooltip>
  );
}

export type ContainerRow = Extract<TreeRowModel, { type: "box" | "group" | "owner" }>;

/**
 * What a container row shows, for the desktop and the phone rows: its
 * name, whether it folds subgroups, whether its counts are plain (Later,
 * Done), the "Only you" lock, and the accessible name with the counts.
 */
export function containerFacts(row: ContainerRow, ownerName?: string) {
  const name =
    row.type === "box"
      ? SECTION_META[row.id].label
      : row.type === "owner"
        ? (ownerName ?? row.ownerId)
        : // Another person's sessions with no group sit directly under the owner.
          row.node.name || "No group";
  const searchMatch = row.type === "group" && row.searchMatch === true;
  const plain = row.type === "box" && (row.id === "later" || row.id === "done");
  const onlyYou = row.type === "group" && row.node.privateClash === true;
  return {
    name,
    searchMatch,
    hasChildren:
      row.type === "owner" ||
      (row.type === "group" && row.node.children.length > 0 && !searchMatch),
    plain,
    onlyYou,
    label: [name, onlyYou && "Only you", row.counts && countsLabel(row.counts, plain)]
      .filter(Boolean)
      .join(", "),
  };
}

interface GroupNodeProps {
  row: ContainerRow;
  domId: string;
  cursor: boolean;
  /** The keyboard cursor is on this row and keys drive the tree: show the "+". */
  showActions: boolean;
  ownerName?: string;
  /** The id of this list's empty or loading line, so screen readers hear it with the row. */
  describedBy?: string;
  onRowClick: (rowKey: string, event: MouseEvent) => void;
  onToggle: (rowKey: string) => void;
  /** "+": a new session. Missing on rows that take none (Inbox, Later, Done, Shared with me). */
  onNewSession?: (rowKey: string) => void;
  /** "⋯", a right-click: the group menu. Missing on rows with no menu. */
  onMenu?: (rowKey: string, event: MouseEvent) => void;
  /** Dropped rows move here: a group key, null for No group. Missing: no drops. */
  dropKey?: string | null;
  /** The name is an input (Rename group). */
  renaming?: boolean;
  /** The rename ended: the group key, and the typed name or null to cancel. */
  onRenameDone?: (groupKey: string, name: string | null) => void;
}

/**
 * The inline group name field (New group, New subgroup, Rename group).
 * Enter saves, Escape and leaving the field cancel (SPEC R5).
 */
export function GroupNameField({
  initial = "",
  label,
  onDone,
  className,
}: {
  initial?: string;
  label: string;
  onDone: (name: string | null) => void;
  /** The phone rows use a taller field with 16 px text. */
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  // Enter and Escape end it once. The blur that follows (the focus goes back
  // to the tree in the same event) must not end it again, so a ref, not state.
  const ended = useRef(false);
  const end = (name: string | null) => {
    if (ended.current) return;
    ended.current = true;
    onDone(name);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") end(value);
    else if (event.key === "Escape") end(null);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <Input
      autoFocus
      value={value}
      aria-label={label}
      placeholder="group-name"
      spellCheck={false}
      maxLength={48}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => end(null)}
      onClick={(event) => event.stopPropagation()}
      onFocus={(event) => event.currentTarget.select()}
      className={cn(
        "h-6 flex-1 rounded-sm bg-background px-1.5 py-0 text-data shadow-none md:text-data",
        className,
      )}
    />
  );
}

/** A row action that shows on hover and on the keyboard cursor. */
function RowAction({
  label,
  shortcut,
  keyName,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  keyName?: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={label}
          aria-keyshortcuts={keyName}
          onMouseDown={keepTreeFocus}
          onClick={(event) => {
            event.stopPropagation();
            onClick(event);
          }}
          className="grid size-6 place-items-center rounded-sm bg-accent text-foreground hover:bg-muted"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-1.5">
        {label}
        {shortcut ? <TipKey>{shortcut}</TipKey> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** The icon of a container row: the section's, a hash, or the owner's avatar. `touch`: a size larger. */
export function RowIcon({
  row,
  ownerName,
  touch = false,
}: {
  row: ContainerRow;
  ownerName?: string;
  touch?: boolean;
}) {
  if (row.type === "owner") {
    return <UserAvatar id={row.ownerId} name={ownerName ?? row.ownerId} size="xs" />;
  }
  const Icon = row.type === "box" ? SECTION_META[row.id].icon : Hash;
  return (
    <Icon aria-hidden className={cn("text-muted-foreground", touch ? "size-4" : "size-3.5")} />
  );
}

function GroupNodeView({
  row,
  domId,
  cursor,
  showActions,
  ownerName,
  describedBy,
  onRowClick,
  onToggle,
  onNewSession,
  onMenu,
  dropKey,
  renaming,
  onRenameDone,
}: GroupNodeProps) {
  const { name, searchMatch, hasChildren, plain, onlyYou, label } = containerFacts(row, ownerName);
  const { dropRef, isOver } = useGroupDroppable(row.key, dropKey);
  const counts = row.counts;
  const foldTip = row.open ? "Hide subgroups" : "Show subgroups";
  const actionCount = renaming ? 0 : Number(Boolean(onMenu)) + Number(Boolean(onNewSession));
  return (
    <TreeRow
      ref={dropRef}
      id={domId}
      level={row.level}
      cursor={cursor}
      aria-expanded={searchMatch ? undefined : row.open}
      aria-label={label}
      aria-describedby={describedBy}
      data-drop-over={isOver ? "true" : undefined}
      onClick={(event) => onRowClick(row.key, event)}
      onContextMenu={onMenu ? (event) => onMenu(row.key, event) : undefined}
      className="h-7 text-data data-[drop-over=true]:bg-primary/10 data-[drop-over=true]:ring-1 data-[drop-over=true]:ring-primary/60 data-[drop-over=true]:ring-inset"
    >
      <span className="grid size-4 shrink-0 place-items-center">
        <RowIcon row={row} ownerName={ownerName} />
      </span>
      {renaming && row.type === "group" ? (
        <GroupNameField
          initial={row.node.name}
          label="Rename group"
          onDone={(next) => onRenameDone?.(row.node.key, next)}
        />
      ) : (
        <span
          className={cn(
            "min-w-0 truncate",
            row.type === "box" ? "font-semibold" : "font-medium",
            row.type === "group" && !row.node.name && "text-muted-foreground",
          )}
        >
          {name}
        </span>
      )}
      {onlyYou ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex shrink-0 text-muted-foreground">
              <Lock aria-hidden className="size-3" />
            </span>
          </TooltipTrigger>
          <TooltipContent>Only you</TooltipContent>
        </Tooltip>
      ) : null}
      {hasChildren ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`${row.open ? "Hide" : "Show"} the subgroups of ${name}`}
              aria-keyshortcuts={row.open ? "ArrowLeft" : "ArrowRight"}
              onMouseDown={keepTreeFocus}
              onClick={(event) => {
                event.stopPropagation();
                onToggle(row.key);
              }}
              className="-ml-0.5 grid size-[18px] shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronDown
                aria-hidden
                className={cn(
                  "size-3.5 transition-transform duration-150 ease-snappy",
                  NO_KEYBOARD_MOTION,
                  !row.open && "-rotate-90",
                )}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-1.5">
            {foldTip}
            <TipKey>{row.open ? "←" : "→"}</TipKey>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {/* The counts and the hover actions share one slot at the end of the
          row. The actions show in place of the counts (on hover and on the
          keyboard cursor), so they never cover the name or the fold
          chevron, at any sidebar width. The slot keeps room for the
          actions. It takes only the room the name leaves (basis 0), so the
          name never truncates while the counts could give way (UX review R9). */}
      <span
        className={cn(
          "relative flex min-w-0 grow basis-0 items-center justify-end",
          actionCount === 2 ? "min-w-12.5" : actionCount === 1 && "min-w-6",
        )}
      >
        {counts ? (
          <SessionCounts
            counts={counts}
            plain={plain}
            className={
              actionCount > 0
                ? cn(
                    // Out at once, back with the row's linger. No fade while keys move.
                    "transition-opacity delay-50 duration-200 ease-snappy group-hover/row:pointer-events-none group-hover/row:opacity-0 group-hover/row:delay-0 group-hover/row:duration-0",
                    NO_KEYBOARD_MOTION,
                    showActions && "pointer-events-none opacity-0",
                  )
                : undefined
            }
          />
        ) : null}
        {actionCount > 0 ? (
          <span
            className={cn(
              "absolute inset-y-0 right-0 flex items-center gap-0.5",
              // In at once, out with the row's linger (UX review R9). No
              // fade at all while keys move the cursor.
              "transition-opacity delay-50 duration-200 ease-snappy group-hover/row:delay-0 group-hover/row:duration-0",
              NO_KEYBOARD_MOTION,
              showActions
                ? "opacity-100"
                : "pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100",
            )}
          >
            {onMenu ? (
              <RowAction label="Group actions" onClick={(event) => onMenu(row.key, event)}>
                <Ellipsis aria-hidden className="size-3.5" />
              </RowAction>
            ) : null}
            {onNewSession ? (
              <RowAction
                label="New session"
                shortcut="C"
                keyName="c"
                onClick={() => onNewSession(row.key)}
              >
                <Plus aria-hidden className="size-3.5" />
              </RowAction>
            ) : null}
          </span>
        ) : null}
      </span>
    </TreeRow>
  );
}

export const GroupNode = memo(GroupNodeView, rowPropsEqual);
