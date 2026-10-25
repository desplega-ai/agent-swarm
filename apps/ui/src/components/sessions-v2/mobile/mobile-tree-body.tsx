/**
 * The sidebar tree's body on a phone (plan Phase 9): the same sections and
 * rows as the desktop tree, drawn with the touch rows of `mobile-tree-row`.
 * `SessionTree` owns the data, the selection, and the dialogs. This part
 * maps the touch gestures onto them:
 *
 * - A tap opens a session, folds a container, or runs a paging row. While a
 *   selection is on, a tap on a session selects it.
 * - A left swipe marks Done (back to the Inbox from Done). A right swipe
 *   opens the Later sheet (back to the Inbox from Later).
 * - A long-press selects a session, or opens the sheet of one of my groups.
 *   It does nothing on a read-only group (Shared with me, a source).
 */

import type { MouseEvent, PointerEvent, ReactNode, RefObject } from "react";
import type { SessionListItem } from "@/api/types";
import { useStableHandler } from "@/hooks/use-stable-handler";
import type { SwipeSide } from "@/hooks/use-swipe-row";
import { cn } from "@/lib/utils";
import { EmptyRow } from "../sidebar/list-state-rows";
import { TreeSection, type TreeSegment } from "../sidebar/section-header";
import { isMyGroupRow, type NavRow, type TreeRow } from "../sidebar/tree-rows";
import type { SessionSelection } from "../sidebar/use-session-selection";
import {
  MobileActionRow,
  MobileContainerRow,
  MobileCreateRow,
  MobileSessionRow,
  MobileSourceRow,
} from "./mobile-tree-row";

export function MobileTreeBody({
  treeRef,
  label,
  segments,
  rowsByKey,
  loading,
  domId,
  stateId,
  describedBy,
  me,
  now,
  nameOf,
  labels,
  selection,
  canTriage,
  renaming,
  doneOrBack,
  laterOrBack,
  openLater,
  openGroupMenu,
  onRowClick,
  onRenameDone,
  onCreateDone,
  onPointerDown,
  renderRow,
}: {
  treeRef: RefObject<HTMLDivElement | null>;
  label: string;
  segments: TreeSegment[];
  rowsByKey: ReadonlyMap<string, NavRow>;
  loading: boolean;
  domId: (key: string) => string;
  stateId: (parentKey: string) => string;
  describedBy: (key: string) => string | undefined;
  me: string | null;
  now: number;
  nameOf: (userId: string) => string;
  /** The source group labels of the tree (`#eng`), for the group label of a flat row. */
  labels: Readonly<Record<string, string>>;
  selection: SessionSelection;
  canTriage: boolean;
  /** The group whose name is an input. */
  renaming: string | null;
  /** Done, or back to the Inbox from Done (`useSessionTriageActions`). */
  doneOrBack: (sessions: SessionListItem[]) => void;
  /** Back to the Inbox from Later, else `pick`. */
  laterOrBack: (sessions: SessionListItem[], pick: () => void) => void;
  /** The Later sheet for these sessions. */
  openLater: (session: SessionListItem, targets: SessionListItem[]) => void;
  openGroupMenu: (rowKey: string, anchor: { x: number; y: number }) => void;
  /** The tree's own click: open, fold, page. */
  onRowClick: (rowKey: string, event: MouseEvent) => void;
  onRenameDone: (groupKey: string, name: string | null) => void;
  onCreateDone: (name: string | null) => void;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  /** The desktop row, for the rows a phone draws the same (loading). */
  renderRow: (row: TreeRow) => ReactNode;
}) {
  const onTap = useStableHandler((key: string, event: MouseEvent) => {
    const row = rowsByKey.get(key);
    if (row?.type === "session" && selection.selectionMode) {
      selection.toggle(row.session.root.id, key);
      return;
    }
    onRowClick(key, event);
  });
  const onSwipe = useStableHandler((key: string, side: SwipeSide) => {
    const row = rowsByKey.get(key);
    if (row?.type !== "session") return;
    const { session } = row;
    if (side === "left") doneOrBack([session]);
    else laterOrBack([session], () => openLater(session, [session]));
  });
  const onLongPress = useStableHandler((key: string) => {
    const row = rowsByKey.get(key);
    if (row?.type === "session") {
      if (!selection.selected.has(row.session.root.id)) selection.toggle(row.session.root.id, key);
    } else openGroupMenu(key, { x: 0, y: 0 });
  });
  const onRename = useStableHandler(onRenameDone);

  const renderPhoneRow = (row: TreeRow) => {
    switch (row.type) {
      case "box":
      case "group":
      case "owner": {
        const mine = isMyGroupRow(row);
        return (
          <MobileContainerRow
            key={row.key}
            row={row}
            domId={domId(row.key)}
            ownerName={row.type === "owner" ? nameOf(row.ownerId) : undefined}
            describedBy={describedBy(row.key)}
            onRowClick={onTap}
            onLongPress={mine ? onLongPress : undefined}
            renaming={mine && !row.searchMatch && renaming === row.node.key}
            onRenameDone={onRename}
          />
        );
      }
      case "source":
        return (
          <MobileSourceRow key={row.key} row={row} domId={domId(row.key)} onRowClick={onTap} />
        );
      case "session":
        return (
          <MobileSessionRow
            key={row.key}
            rowKey={row.key}
            session={row.session}
            domId={domId(row.key)}
            level={row.level}
            flat={row.flat}
            me={me}
            now={now}
            labels={labels}
            selected={selection.selected.has(row.session.root.id)}
            selecting={selection.selectionMode}
            canTriage={canTriage}
            highlight={row.match}
            onRowClick={onTap}
            onSwipe={onSwipe}
            onLongPress={onLongPress}
          />
        );
      case "more":
      case "all":
      case "add":
        return (
          <MobileActionRow
            key={row.key}
            id={domId(row.key)}
            level={row.level}
            kind={row.type}
            label={
              row.type === "more"
                ? `Show ${row.count} more`
                : row.type === "all"
                  ? `View all ${row.total}`
                  : "New group"
            }
            onClick={(event) => onRowClick(row.key, event)}
          />
        );
      case "create":
        return (
          <MobileCreateRow
            key={row.key}
            level={row.level}
            subgroup={row.parent !== "shared/"}
            onDone={onCreateDone}
          />
        );
      case "empty":
        return (
          <EmptyRow
            key={row.key}
            id={stateId(row.parentKey)}
            level={0}
            kind={row.kind}
            canTriage={canTriage}
            note={row.note}
            phone
          />
        );
      default:
        return renderRow(row);
    }
  };

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label={label}
      aria-multiselectable
      aria-busy={loading || undefined}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6 outline-none",
        // The selection bar covers the end of the list: the last rows stay above it.
        selection.selectionMode && "pb-24",
      )}
    >
      {segments.map(({ section, rows }) =>
        section ? (
          <TreeSection key={section.key} section={section} describedBy={describedBy(section.key)}>
            {rows.map(renderPhoneRow)}
          </TreeSection>
        ) : (
          rows.map(renderPhoneRow)
        ),
      )}
    </div>
  );
}
