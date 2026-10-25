/**
 * The sessions v2 sidebar tree (plan Phases 4 and 5, SPEC R4 to R6, R9,
 * R10.3): the search, then Inbox, Later, Done, No group, My groups,
 * Shared with me, and the source sections, with server counts, paged rows,
 * read state, triage, selection, moves, and group edits.
 *
 * The parts: `useMyGroups` (the groups), `useTreeRows` (the flat row list),
 * `useSearchRows`, `useTreeFolds`, `useTreeCursor` (keys, focus, the
 * hover-card peek), `useSessionSelection`, `useSessionTriageActions`, `useTreeMoves`,
 * `useGroupEdits`, `useRowDrag`, `useTreeDialogs` with `TreeDialogs`, and
 * `useSessionsCommands` (Cmd+K). This file holds the key map, the pointer
 * handlers, and the render.
 *
 * `phone` (plan Phase 9) draws the same rows for touch (`MobileTreeBody`):
 * swipe, long-press, the phone selection bars, and sheets for the Later and
 * group menus. No drag, no hover card.
 */

import { DndContext, DragOverlay } from "@dnd-kit/core";
import { CircleAlert } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useSessionLabels } from "@/api/hooks/use-session-tree";
import { useSessionListTriage } from "@/api/hooks/use-session-triage";
import { useUsers } from "@/api/hooks/use-users";
import type { SessionListItem } from "@/api/types";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/contexts/current-user-context";
import type { SessionsViewMode } from "@/hooks/use-sessions-view";
import { useStableHandler } from "@/hooks/use-stable-handler";
import { useSessionsFilter } from "@/lib/sessions-show";
import { SESSIONS_TOAST_POSITION, type SessionSection, userName } from "@/lib/sessions-v2";
import { MobileBulkBar } from "../mobile/mobile-bulk-bar";
import { MobileTreeBody } from "../mobile/mobile-tree-body";
import { useListKeys } from "../use-list-keys";
import { useMyGroups } from "../use-my-groups";
import { useSessionTriageActions } from "../use-session-triage-actions";
import { type SessionsCommandsApi, useSessionsCommands } from "../use-sessions-commands";
import { BulkBar, type WholeListOffer } from "./bulk-bar";
import { FilterMenu } from "./filter-menu";
import { GroupNode, SECTION_META } from "./group-node";
import { AddGroupRow, CreateGroupRow, EmptyRow, LoadingRow, PagingRow } from "./list-state-rows";
import type { RowMenuActions, RowMenuState } from "./row-menu";
import { SourceHeader, segmentsOf, TreeSection } from "./section-header";
import { SessionDragPreview, SessionRow } from "./session-row";
import { SidebarSearch } from "./sidebar-search";
import { TreeDialogs, useTreeDialogs } from "./tree-dialogs";
import {
  type ContainerId,
  foldId,
  isMyGroupRow,
  isNavRow,
  type NavRow,
  type TreeRow as TreeRowModel,
  wholeListTotal,
} from "./tree-rows";
import { useGroupEdits } from "./use-group-edits";
import { useRowDrag } from "./use-row-drag";
import { SEARCH_CONTAINER, useSearchRows } from "./use-search-rows";
import { useSessionSelection } from "./use-session-selection";
import { useTreeCursor } from "./use-tree-cursor";
import { useTreeFolds } from "./use-tree-folds";
import { useTreeMoves } from "./use-tree-moves";
import { useTreeRows } from "./use-tree-rows";

/** The clock rows read their times from. It ticks once a minute, with no animation. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Registers the Cmd+K commands. Its own component, so palette typing renders only it. */
function SessionsCommands(props: Parameters<typeof useSessionsCommands>[0]) {
  useSessionsCommands(props);
  return null;
}

interface SessionTreeProps {
  /** The session in the focused pane, or the New session tab. */
  focused: string;
  /** `newTab` opens a tab in front, `background` adds one behind (a middle-click). */
  openSession: (id: string, options?: { newTab?: boolean; background?: boolean }) => void;
  /** Open the New session tab, starting in `group` (null: No group). */
  newSession: (group?: string | null) => void;
  /** "View all N": open the list in the group tab (`?view=`). */
  setView: (view: string) => void;
  /** The sidebar search (`?q=`). */
  query: string;
  setQuery: (query: string) => void;
  /** "Legacy sessions" in Cmd+K. */
  onViewChange: (view: SessionsViewMode) => void;
  /** Cmd+K "Rename session": the pane header's title turns into its rename field. */
  onRename: () => void;
  /** The split and the guide: `v`, "Open in split" in the row menu, and their Cmd+K commands. */
  paneCommands: PaneCommands;
  /** The tree's move dialog and group reveal, for the pane header. */
  ref: Ref<SessionTreeHandle>;
  /** The phone list screen: touch rows, swipe, long-press, and sheets. */
  phone?: boolean;
  /** The phone search mode turned on or off. */
  onSearchMode?: (on: boolean) => void;
}

/** What the tree asks of the pane area (plan Phase 8). */
export interface PaneCommands {
  openInSplit: (id: string) => void;
  pickSplit: () => void;
  /** Only while a split is open. */
  closeSplit?: () => void;
  showGuide: () => void;
}

/** What the pane header asks of the tree. */
export interface SessionTreeHandle {
  /** Open the move dialog. `returnFocus` runs when it closes. */
  move: (sessions: SessionListItem[], returnFocus: () => void) => void;
  /** Show a group (null: No group) with the tree cursor on it, and focus the tree. */
  revealGroup: (groupKey: string | null) => void;
}

export function SessionTree({
  focused,
  openSession,
  newSession,
  setView,
  query,
  setQuery,
  onViewChange,
  onRename,
  paneCommands,
  ref,
  phone = false,
  onSearchMode,
}: SessionTreeProps) {
  const { userId } = useCurrentUser();
  const me = userId ?? null;
  // The tree and list queries below read the filter (Mine / All, hidden sources): re-render on a change.
  useSessionsFilter();
  const now = useMinuteClock();
  const [expanded, setExpanded] = useState<ReadonlySet<ContainerId>>(() => new Set());
  const { isOpen, setOpen, prune } = useTreeFolds(me);
  const myGroups = useMyGroups(me);
  const { groups, targets, writeBlock } = myGroups;
  const labels = useSessionLabels();
  /** A new group's name field shows under this parent (`shared/` for the top level). */
  const [creating, setCreating] = useState<string | null>(null);
  /** The group whose name is an input. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const searching = query.trim() !== "";
  const treeRows = useTreeRows({ me, myGroups, isOpen, expanded, creating, paused: searching });
  useEffect(() => {
    if (groups) prune(groups);
  }, [groups, prune]);

  const users = useUsers({ enabled: (groups?.sharedWithMe.length ?? 0) > 0 });
  const nameOf = useCallback((id: string) => userName(users.data, id), [users.data]);
  const search = useSearchRows({ me, query, groups, nameOf });
  const rows = search.active ? search.rows : treeRows;
  const targetKeys = useMemo(() => new Set(targets.map((target) => target.key)), [targets]);

  const navRows = useMemo(() => rows.filter(isNavRow), [rows]);
  const rowsByKey = useMemo(() => new Map(navRows.map((row) => [row.key, row])), [navRows]);
  const baseId = useId();
  const domId = useCallback((key: string) => `${baseId}${encodeURIComponent(key)}`, [baseId]);
  const treeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusTree = () => treeRef.current?.focus({ preventScroll: true });

  const dialogs = useTreeDialogs(focusTree);
  const cursor = useTreeCursor({ navRows, focused, treeRef, domId, menuOpen: dialogs.menuOpen });
  const { cursorRow, cursorIndex, keyboard } = cursor;
  const cursorSession = cursorRow?.type === "session" ? cursorRow.session : null;
  const selection = useSessionSelection(rows);

  const openMove = (sessions: SessionListItem[], returnFocus?: () => void) => {
    if (sessions.length === 0) return;
    dialogs.takeFocus();
    dialogs.setPick({ purpose: "move", sessions, returnFocus });
  };
  /** The Later sheet on a phone (a right swipe, the selection bar). */
  const laterMenu = (session: SessionListItem, targets: SessionListItem[]) =>
    dialogs.setMenu({ x: 0, y: 0, kind: "later", session, targets });
  const triage = useSessionTriageActions({
    clearSelection: selection.clear,
    pickDate: dialogs.pickDate,
    pickGroup: openMove,
  });
  const { canTriage } = triage;
  const actions: RowMenuActions = {
    ...triage.actions,
    open: (session) => openSession(session.root.id),
    openNewTab: (session) => openSession(session.root.id, { newTab: true }),
    openInSplit: (session) => paneCommands.openInSplit(session.root.id),
  };
  const moves = useTreeMoves({
    me,
    nameOf,
    labels,
    emptyGroups: myGroups.emptyGroups,
    serverKeys: myGroups.serverKeys,
    targetKeys,
    writeBlock,
    isOpen,
    setOpen,
    clearSelection: selection.clear,
  });
  const listTriage = useSessionListTriage();
  /** The name of a list: its section, else its group. */
  const listLabel = (container: ContainerId) =>
    container in SECTION_META
      ? SECTION_META[container as SessionSection].label
      : moves.labelOf(container);
  /** The list a row belongs to or heads: Cmd+A and the list checkbox select its loaded rows. */
  const listAt = (row: NavRow | null | undefined): ContainerId | null => {
    if (row?.type === "session" || row?.type === "more" || row?.type === "all") {
      return row.container;
    }
    if (row?.type === "box") return row.id;
    if (row?.type === "group") return row.node.key;
    return null;
  };
  // "Select all N": offered while the selection is every loaded row of a
  // list that has more sessions than it loaded, and kept while it is on.
  const offerList = selection.wholeList ?? (selection.selectionMode ? selection.fullList() : null);
  const offerTotal = offerList ? wholeListTotal(rows, offerList) : null;
  const whole: WholeListOffer | null =
    offerList && offerTotal !== null
      ? {
          label: listLabel(offerList),
          total: offerTotal,
          on: selection.wholeList === offerList,
          onSelect: () => {
            selection.selectWholeList();
            if (!phone) focusTree();
          },
        }
      : null;
  const wholeOn = whole?.on ? offerList : null;
  /** The list's unread count says Mark read or Mark unread, as `anyUnread` does for rows. */
  const listUnread = (container: ContainerId) =>
    rows.some(
      (row) =>
        ((row.type === "box" && row.id === container) ||
          (row.type === "group" && row.node.key === container)) &&
        row.counts.unread > 0,
    );
  /** Done on the whole list, or back to the Inbox from Done (the `e` toggle). */
  const wholeDone = (container: ContainerId) => {
    listTriage.run(container, container === "done" ? "inbox" : "done");
    selection.clear();
  };
  const wholeRead = (container: ContainerId) => {
    listTriage.run(container, listUnread(container) ? "read" : "unread");
    selection.clear();
  };
  const drag = useRowDrag({
    dragTargets: selection.menuTargets,
    onDrop: (sessions, key) => void moves.move(sessions, key),
  });
  const edits = useGroupEdits({
    creating,
    setCreating,
    setRenaming,
    moves,
    dialogs,
    searching,
    setQuery,
    setOpen,
    newSession,
    placeCursor: cursor.place,
    focusTree,
    phone,
  });
  useImperativeHandle(ref, () => ({
    move: openMove,
    revealGroup: (groupKey) => {
      // Focus first: a first focus puts the cursor on its default row.
      focusTree();
      edits.revealGroup(groupKey);
      // Keyboard mode scrolls the cursor row into view and shows the cursor.
      cursor.enterKeyMode();
    },
  }));

  /** Open the row menu (or its Later part) at a row, for the keys and Cmd+K. */
  const menuAtRow = (
    rowKey: string | null,
    kind: RowMenuState["kind"],
    session: SessionListItem,
    targets: SessionListItem[],
  ) => {
    const row = rowKey ? document.getElementById(domId(rowKey)) : null;
    const rect = (row ?? treeRef.current)?.getBoundingClientRect();
    const y = row ? (rect?.bottom ?? 0) + 2 : (rect?.top ?? 0);
    dialogs.setMenu({ x: (rect?.left ?? 0) + 24, y, kind, session, targets });
  };
  /** The group menu of a row, at the pointer (right-click) or under the control or row. */
  const openGroupMenu = (rowKey: string, anchor: { x: number; y: number }) => {
    const row = rowsByKey.get(rowKey);
    if (!isMyGroupRow(row)) return;
    cursor.place(rowKey);
    const groupKey = row.node.key;
    dialogs.setGroupMenu({
      ...anchor,
      groupKey,
      label: moves.labelOf(groupKey),
      writeBlock: writeBlock(groupKey),
    });
  };

  // ── Row actions ────────────────────────────────────────────────────────
  const toggleRow = (row: NavRow) => {
    const id = foldId(row);
    if (id) setOpen(id, !isOpen(id));
  };
  /** Enter, `o`, or a click on a row. */
  const activate = (row: NavRow) => {
    if (row.type === "session") openSession(row.session.root.id);
    else if (row.type === "more") {
      if (row.container === SEARCH_CONTAINER) search.more();
      else setExpanded((prev) => new Set(prev).add(row.container));
    } else if (row.type === "all") setView(row.container);
    else if (row.type === "add") edits.startCreate("shared/");
    else if (row.type === "group" && row.searchMatch) edits.revealGroup(row.node.key);
    else toggleRow(row);
  };
  /**
   * Where `c`, "+", and Cmd+K "New session" start (SPEC R3): the group under
   * the cursor, else the cursor session's group, else No group. A group this
   * connection cannot start a session in gives No group.
   */
  const startGroupOf = (row: NavRow | null | undefined): string | null => {
    const key = isMyGroupRow(row)
      ? row.node.key
      : row?.type === "session" && targetKeys.has(row.container)
        ? row.container
        : null;
    return key && !writeBlock(key) ? key : null;
  };
  const goNextUnread = () => {
    const count = navRows.length;
    for (let step = 1; step <= count; step++) {
      const row = navRows[(Math.max(cursorIndex, 0) + step) % count];
      if (
        row.type === "session" &&
        row.session.readState === "unread" &&
        row.session.root.id !== focused
      ) {
        cursor.place(row.key);
        openSession(row.session.root.id);
        return;
      }
    }
    toast("No unread sessions in the open lists.", { position: SESSIONS_TOAST_POSITION });
  };
  /** What a key acts on: the selection, else the cursor's session. */
  const keyTargets = () => selection.keyTargets(cursorSession);

  const onKeyDown = useListKeys({
    next: () => cursor.moveTo(cursorIndex + 1),
    prev: () => cursor.moveTo(cursorIndex - 1),
    first: () => cursor.moveTo(0),
    last: () => cursor.moveTo(navRows.length - 1),
    open: () => {
      cursor.enterKeyMode();
      if (cursorRow) activate(cursorRow);
    },
    expand: () => {
      cursor.enterKeyMode();
      const id = cursorRow && foldId(cursorRow);
      if (!id) return;
      if (!isOpen(id)) setOpen(id, true);
      else cursor.moveTo(cursorIndex + 1);
    },
    collapse: () => {
      cursor.enterKeyMode();
      if (!cursorRow) return;
      const id = foldId(cursorRow);
      if (id && isOpen(id)) {
        setOpen(id, false);
        return;
      }
      // Up to the parent row.
      for (let i = cursorIndex - 1; i >= 0; i--) {
        if (foldId(navRows[i]) && navRows[i].level < cursorRow.level) {
          cursor.moveTo(i);
          return;
        }
      }
    },
    newTab: () => {
      if (cursorSession) openSession(cursorSession.root.id, { newTab: true });
    },
    split: () => {
      if (cursorSession) paneCommands.openInSplit(cursorSession.root.id);
    },
    nextUnread: () => {
      cursor.enterKeyMode();
      goNextUnread();
    },
    newSession: () => newSession(startGroupOf(cursorRow)),
    move: () => {
      // The whole list moves nowhere: moves check each session (at most 200).
      if (!wholeOn) openMove(keyTargets());
    },
    select: () => {
      if (cursorSession && cursorRow) selection.toggle(cursorSession.root.id, cursorRow.key);
    },
    menu: () => {
      if (!cursorRow) return;
      const rect = document.getElementById(domId(cursorRow.key))?.getBoundingClientRect();
      if (cursorSession) {
        const targets = selection.menuTargets(cursorSession);
        menuAtRow(cursorRow.key, "row", cursorSession, targets);
      } else if (rect) openGroupMenu(cursorRow.key, { x: rect.left + 24, y: rect.bottom + 2 });
    },
    ...(canTriage
      ? {
          done: () => (wholeOn ? wholeDone(wholeOn) : triage.doneOrBack(keyTargets())),
          later: () => {
            const targets = keyTargets();
            if (!cursorRow || wholeOn) return;
            triage.laterOrBack(targets, () =>
              menuAtRow(cursorRow.key, "later", cursorSession ?? targets[0], targets),
            );
          },
          read: () => {
            if (wholeOn) return wholeRead(wholeOn);
            const targets = keyTargets();
            if (targets.length > 0) actions.toggleRead(targets);
          },
        }
      : {}),
    // A peek card or a tooltip takes the first Escape (it marks it handled).
    // Then Escape clears the selection, then the search.
    clear: selection.selectionMode ? selection.clear : searching ? () => setQuery("") : undefined,
  });

  /** Cmd+A (Ctrl+A): the loaded rows of the cursor's list. Other keys go to the list keys. */
  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const selectAll =
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "a" &&
      !(event.target as Element).closest("input");
    const list = selectAll ? listAt(cursorRow) : null;
    if (!list) {
      onKeyDown(event);
      return;
    }
    event.preventDefault();
    cursor.enterKeyMode();
    selection.selectList(list);
  };

  // ── Pointer handlers: stable, so the memoized rows render only on change.
  /**
   * A press anywhere in the tree gives it the focus, so the keys act next.
   * Row controls (the checkbox, "+", "⋯") keep the focus off themselves, and
   * on load the composer has it. The group name field keeps its own focus.
   */
  const onTreePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    cursor.onPointerDown();
    if (!(event.target as Element).closest("input")) focusTree();
  };
  const onRowClick = useStableHandler((key: string, event: MouseEvent) => {
    const row = rowsByKey.get(key);
    if (!row) return;
    const from = cursorRow?.key ?? null;
    cursor.place(key);
    if (row.type === "session" && event.shiftKey) {
      selection.selectRange(key, from);
      return;
    }
    if (row.type === "session" && (event.metaKey || event.ctrlKey)) {
      selection.toggle(row.session.root.id, key);
      return;
    }
    activate(row);
  });
  /** `range`: a Shift+click on the checkbox. */
  const onToggleSelect = useStableHandler((key: string, range = false) => {
    const row = rowsByKey.get(key);
    if (row?.type !== "session") return;
    const from = cursorRow?.key ?? null;
    cursor.place(key);
    focusTree();
    if (range) selection.selectRange(key, from);
    else selection.toggle(row.session.root.id, key);
  });
  const onRowAuxClick = useStableHandler((key: string, event: MouseEvent) => {
    const row = rowsByKey.get(key);
    if (event.button !== 1 || row?.type !== "session") return;
    event.preventDefault();
    openSession(row.session.root.id, { background: true });
  });
  const onRowContextMenu = useStableHandler((key: string, event: MouseEvent) => {
    const row = rowsByKey.get(key);
    if (row?.type !== "session") return;
    event.preventDefault();
    cursor.place(key);
    const { clientX: x, clientY: y } = event;
    const targets = selection.menuTargets(row.session);
    dialogs.setMenu({ x, y, kind: "row", session: row.session, targets });
  });
  const onGroupMenu = useStableHandler((key: string, event: MouseEvent) => {
    event.preventDefault();
    if (event.type === "contextmenu") {
      openGroupMenu(key, { x: event.clientX, y: event.clientY });
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openGroupMenu(key, { x: rect.left, y: rect.bottom + 2 });
  });
  const onToggle = useStableHandler((key: string) => {
    const row = rowsByKey.get(key);
    if (!row) return;
    cursor.place(key);
    toggleRow(row);
  });
  const onNewSession = useStableHandler((key: string) =>
    newSession(startGroupOf(rowsByKey.get(key))),
  );
  const onRenameDone = useStableHandler(edits.onRenameDone);
  /** A list's checkbox, on its section or group row. */
  const onToggleList = useStableHandler((key: string) => {
    const list = listAt(rowsByKey.get(key));
    if (!list) return;
    cursor.place(key);
    focusTree();
    selection.toggleList(list);
  });
  const onPeekClose = useStableHandler(cursor.closePeek);

  const commandsApi: SessionsCommandsApi = {
    open: (id) => openSession(id),
    newSession: () => newSession(startGroupOf(cursorRow)),
    newSessionIn: () => dialogs.setPick({ purpose: "new" }),
    nextUnread: goNextUnread,
    move: openMove,
    rename: onRename,
    triage: actions,
    later: (session) => {
      const id = session.root.id;
      const row = navRows.find((r) => r.type === "session" && r.session.root.id === id);
      menuAtRow(row?.key ?? null, "later", session, [session]);
    },
    legacy: () => onViewChange("legacy"),
    pickSplit: paneCommands.pickSplit,
    closeSplit: paneCommands.closeSplit,
    showGuide: paneCommands.showGuide,
  };

  /** The id of the empty or loading line that describes a row or a section. */
  const stateId = (parentKey: string) => `${domId(parentKey)}-state`;
  const described = new Set<string>();
  for (const row of rows)
    if (row.type === "empty" || row.type === "loading") described.add(row.parentKey);
  const describedBy = (key: string) => (described.has(key) ? stateId(key) : undefined);

  const renderRow = (row: TreeRowModel) => {
    switch (row.type) {
      case "section":
        return null;
      case "box":
      case "group":
      case "owner": {
        // Shared with me and source groups are read-only: no menu, no "+", no drops.
        const mine = isMyGroupRow(row);
        // A personal group on the operator key takes no new sessions and no drops.
        const writable = mine && !writeBlock(row.node.key);
        const noGroupBox = row.type === "box" && row.id === "nogroup";
        return (
          <GroupNode
            key={row.key}
            row={row}
            domId={domId(row.key)}
            cursor={row.key === cursorRow?.key}
            showActions={keyboard && row.key === cursorRow?.key}
            ownerName={row.type === "owner" ? nameOf(row.ownerId) : undefined}
            describedBy={describedBy(row.key)}
            onRowClick={onRowClick}
            onToggle={onToggle}
            onNewSession={writable || noGroupBox ? onNewSession : undefined}
            onMenu={mine ? onGroupMenu : undefined}
            dropKey={writable ? row.node.key : noGroupBox ? null : undefined}
            renaming={mine && !row.searchMatch && renaming === row.node.key}
            onRenameDone={onRenameDone}
            listSelect={row.type === "owner" ? null : selection.listState(listAt(row) ?? "")}
            selecting={selection.selectionMode}
            onToggleList={onToggleList}
          />
        );
      }
      case "source":
        return (
          <SourceHeader
            key={row.key}
            row={row}
            domId={domId(row.key)}
            cursor={row.key === cursorRow?.key}
            onRowClick={onRowClick}
          />
        );
      case "session": {
        const id = row.session.root.id;
        const isCursor = row.key === cursorRow?.key;
        return (
          <SessionRow
            key={row.key}
            rowKey={row.key}
            session={row.session}
            domId={domId(row.key)}
            level={row.level}
            flat={row.flat}
            me={me}
            now={now}
            open={id === focused}
            cursor={isCursor}
            selected={selection.selected.has(id)}
            showCheckbox={selection.selectionMode || (keyboard && isCursor)}
            highlight={row.match}
            peek={cursor.peekKey === row.key}
            keyboard={keyboard}
            nameOf={nameOf}
            labels={labels}
            onRowClick={onRowClick}
            onRowAuxClick={onRowAuxClick}
            onRowContextMenu={onRowContextMenu}
            onToggleSelect={onToggleSelect}
            onPeekClose={onPeekClose}
          />
        );
      }
      case "more":
      case "all":
        return (
          <PagingRow
            key={row.key}
            id={domId(row.key)}
            level={row.level}
            cursor={row.key === cursorRow?.key}
            label={row.type === "more" ? `Show ${row.count} more` : `View all ${row.total}`}
            all={row.type === "all"}
            onClick={(event) => onRowClick(row.key, event)}
          />
        );
      case "add":
        return (
          <AddGroupRow
            key={row.key}
            id={domId(row.key)}
            cursor={row.key === cursorRow?.key}
            onClick={(event) => onRowClick(row.key, event)}
          />
        );
      case "create":
        return (
          <CreateGroupRow
            key={row.key}
            level={row.level}
            subgroup={row.parent !== "shared/"}
            onDone={edits.onCreateDone}
          />
        );
      case "empty":
        return (
          <EmptyRow
            key={row.key}
            id={stateId(row.parentKey)}
            level={row.level}
            kind={row.kind}
            canTriage={canTriage}
            note={row.note}
          />
        );
      case "loading":
        return <LoadingRow key={row.key} id={stateId(row.parentKey)} level={row.level} />;
    }
  };

  let body: ReactNode;
  if (myGroups.treeQuery.isPending) {
    body = (
      <div aria-busy="true" className="flex flex-col gap-2 px-4 py-3">
        {["a", "b", "c", "d"].map((key) => (
          <Skeleton key={key} className="h-4 w-full" />
        ))}
      </div>
    );
  } else if (!myGroups.treeQuery.data) {
    body = (
      <EmptyState
        compact
        icon={CircleAlert}
        title="Couldn't load sessions."
        description={myGroups.treeQuery.error?.message}
      />
    );
  } else if (phone) {
    body = (
      <MobileTreeBody
        treeRef={treeRef}
        label={searching ? "Search results" : "Sessions"}
        segments={segmentsOf(rows)}
        rowsByKey={rowsByKey}
        loading={rows.some((row) => row.type === "loading")}
        domId={domId}
        stateId={stateId}
        describedBy={describedBy}
        me={me}
        now={now}
        nameOf={nameOf}
        labels={labels}
        selection={selection}
        canTriage={canTriage}
        renaming={renaming}
        doneOrBack={triage.doneOrBack}
        laterOrBack={triage.laterOrBack}
        openLater={laterMenu}
        openGroupMenu={openGroupMenu}
        onRowClick={onRowClick}
        onRenameDone={onRenameDone}
        onCreateDone={edits.onCreateDone}
        onPointerDown={onTreePointerDown}
        renderRow={renderRow}
      />
    );
  } else {
    body = (
      <DndContext
        sensors={drag.sensors}
        accessibility={drag.accessibility}
        onDragStart={drag.onDragStart}
        onDragEnd={drag.onDragEnd}
        onDragCancel={drag.onDragCancel}
      >
        <div
          ref={treeRef}
          role="tree"
          aria-label={searching ? "Search results" : "Sessions"}
          aria-multiselectable
          aria-activedescendant={cursorRow ? domId(cursorRow.key) : undefined}
          aria-busy={rows.some((row) => row.type === "loading") || undefined}
          tabIndex={0}
          data-kb={keyboard ? "true" : undefined}
          onKeyDown={onTreeKeyDown}
          onFocus={cursor.onFocus}
          onBlur={cursor.onBlur}
          onPointerDown={onTreePointerDown}
          className="group/tree min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1.5 pb-4 outline-none"
        >
          {segmentsOf(rows).map(({ section, rows: segmentRows }) =>
            section ? (
              <TreeSection
                key={section.key}
                section={section}
                describedBy={describedBy(section.key)}
              >
                {segmentRows.map(renderRow)}
              </TreeSection>
            ) : (
              segmentRows.map(renderRow)
            ),
          )}
        </div>
        {createPortal(
          <DragOverlay dropAnimation={null}>
            {drag.dragging ? <SessionDragPreview sessions={drag.dragging} /> : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    );
  }

  const selected = selection.selectionMode ? selection.sessions() : [];
  /** The phone's "Select all": the selection's list, while some of its loaded rows are not selected. */
  const selectionList = selection.fullList() ? null : selection.list;
  const anyUnread = wholeOn
    ? listUnread(wholeOn)
    : selected.some((session) => session.readState === "unread");
  // The bar goes with the selection: the focus goes back to the list.
  const andFocus = (run: () => void) => () => {
    run();
    focusTree();
  };
  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      {phone ? (
        <MobileBulkBar
          open={selected.length > 0}
          count={selected.length}
          canTriage={canTriage}
          anyUnread={anyUnread}
          onDone={() => (wholeOn ? wholeDone(wholeOn) : actions.done(selected))}
          onLater={() => laterMenu(selected[0], selected)}
          onToggleRead={() => (wholeOn ? wholeRead(wholeOn) : actions.toggleRead(selected))}
          onMove={() => openMove(selected)}
          onClear={selection.clear}
          onSelectList={selectionList ? () => selection.selectList(selectionList) : undefined}
          whole={whole}
        />
      ) : selected.length > 0 ? (
        <BulkBar
          count={selected.length}
          canTriage={canTriage}
          anyUnread={anyUnread}
          onDone={andFocus(() => (wholeOn ? wholeDone(wholeOn) : actions.done(selected)))}
          onLater={({ left, bottom }) =>
            dialogs.setMenu({
              x: left,
              y: bottom + 4,
              kind: "later",
              session: selected[0],
              targets: selected,
            })
          }
          onToggleRead={andFocus(() =>
            wholeOn ? wholeRead(wholeOn) : actions.toggleRead(selected),
          )}
          onMove={() => openMove(selected)}
          onClear={andFocus(selection.clear)}
          whole={whole}
        />
      ) : null}
      <SidebarSearch
        value={query}
        onChange={setQuery}
        inputRef={searchRef}
        phone={phone}
        groups={targets}
        onSearchMode={onSearchMode}
        onLeave={() => {
          focusTree();
          if (searching) cursor.moveTo(0);
        }}
        action={
          <FilterMenu
            sources={myGroups.treeQuery.data?.sources ?? []}
            canShow={me !== null}
            phone={phone}
          />
        }
      />
      {body}
      <TreeDialogs
        dialogs={dialogs}
        focused={focused}
        canTriage={canTriage}
        triage={actions}
        groupActions={edits.groupActions}
        targets={targets}
        writeBlock={writeBlock}
        moves={moves}
        newSession={newSession}
        focusTree={focusTree}
        phone={phone}
      />
      <SessionsCommands
        focused={focused}
        rows={rows}
        treeRows={treeRows}
        canTriage={canTriage}
        api={commandsApi}
      />
    </TooltipProvider>
  );
}
