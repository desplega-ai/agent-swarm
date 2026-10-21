/**
 * The sessions v2 sidebar tree (plan Phases 4 and 5, SPEC R4 to R6, R9,
 * R10.3): the search, then Inbox, Later, Done, No group, My groups, and
 * Shared with me, with server counts, paged rows, read state, triage,
 * selection, moves, and group edits.
 *
 * The parts: `useMyGroups` (the groups), `useTreeRows` (the flat row list),
 * `useSearchRows`, `useTreeFolds`, `useTreeCursor` (keys, focus, the
 * hover-card peek), `useSessionSelection`, `useTreeTriage`, `useTreeMoves`,
 * `useGroupEdits`, `useRowDrag`, `useTreeDialogs` with `TreeDialogs`, and
 * `useSessionsCommands` (Cmd+K). This file holds the key map, the pointer
 * handlers, and the render.
 */

import { DndContext, DragOverlay } from "@dnd-kit/core";
import { CircleAlert } from "lucide-react";
import {
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useUsers } from "@/api/hooks/use-users";
import type { SessionListItem } from "@/api/types";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/contexts/current-user-context";
import type { SessionsViewMode } from "@/hooks/use-sessions-view";
import { useStableHandler } from "@/hooks/use-stable-handler";
import { SESSIONS_TOAST_POSITION } from "@/lib/sessions-v2";
import { useListKeys } from "../use-list-keys";
import { useMyGroups } from "../use-my-groups";
import { type SessionsCommandsApi, useSessionsCommands } from "../use-sessions-commands";
import { BulkBar } from "./bulk-bar";
import { GroupNode } from "./group-node";
import { AddGroupRow, CreateGroupRow, EmptyRow, LoadingRow, PagingRow } from "./list-state-rows";
import type { RowMenuState } from "./row-menu";
import { SectionHeader } from "./section-header";
import { SessionDragPreview, SessionRow } from "./session-row";
import { SidebarSearch } from "./sidebar-search";
import { TreeDialogs, useTreeDialogs } from "./tree-dialogs";
import {
  type ContainerId,
  foldId,
  isNavRow,
  type NavRow,
  type TreeRow as TreeRowModel,
} from "./tree-rows";
import { useGroupEdits } from "./use-group-edits";
import { useRowDrag } from "./use-row-drag";
import { SEARCH_CONTAINER, useSearchRows } from "./use-search-rows";
import { useSessionSelection } from "./use-session-selection";
import { useTreeCursor } from "./use-tree-cursor";
import { useTreeFolds } from "./use-tree-folds";
import { useTreeMoves } from "./use-tree-moves";
import { useTreeRows } from "./use-tree-rows";
import { useTreeTriage } from "./use-tree-triage";

/** The clock rows read their times from. It ticks once a minute, with no animation. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** A section and the rows under it, so the section can label its tree group. */
interface Segment {
  section: Extract<TreeRowModel, { type: "section" }> | null;
  rows: TreeRowModel[];
}

function segmentsOf(rows: TreeRowModel[]): Segment[] {
  const segments: Segment[] = [{ section: null, rows: [] }];
  for (const row of rows) {
    if (row.type === "section") segments.push({ section: row, rows: [] });
    else segments[segments.length - 1].rows.push(row);
  }
  return segments;
}

/** Registers the Cmd+K commands. Its own component, so palette typing renders only it. */
function SessionsCommands(props: Parameters<typeof useSessionsCommands>[0]) {
  useSessionsCommands(props);
  return null;
}

interface SessionTreeProps {
  /** The session in the focused pane, or the New session tab. */
  focused: string;
  openSession: (id: string, options?: { newTab?: boolean }) => void;
  /** Open the New session tab, starting in `group` (null: No group). */
  newSession: (group?: string | null) => void;
  /** "View all N": open the list in the group tab (`?view=`). */
  setView: (view: string) => void;
  /** The sidebar search (`?q=`). */
  query: string;
  setQuery: (query: string) => void;
  /** "Legacy sessions" in Cmd+K. */
  onViewChange: (view: SessionsViewMode) => void;
}

export function SessionTree({
  focused,
  openSession,
  newSession,
  setView,
  query,
  setQuery,
  onViewChange,
}: SessionTreeProps) {
  const { userId } = useCurrentUser();
  const me = userId ?? null;
  const now = useMinuteClock();
  const [expanded, setExpanded] = useState<ReadonlySet<ContainerId>>(() => new Set());
  const { isOpen, setOpen, prune } = useTreeFolds(me);
  const myGroups = useMyGroups(me);
  const { groups, targets, writeBlock } = myGroups;
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
  const nameOf = useCallback(
    (id: string) => users.data?.find((user) => user.id === id)?.name ?? "Someone",
    [users.data],
  );
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

  const openMove = (sessions: SessionListItem[]) => {
    if (sessions.length === 0) return;
    dialogs.takeFocus();
    dialogs.setPick({ purpose: "move", sessions });
  };
  const { canTriage, actions } = useTreeTriage({
    openSession,
    clearSelection: selection.clear,
    pickDate: dialogs.pickDate,
    pickGroup: openMove,
  });
  const moves = useTreeMoves({
    me,
    nameOf,
    emptyGroups: myGroups.emptyGroups,
    serverKeys: myGroups.serverKeys,
    targetKeys,
    writeBlock,
    isOpen,
    setOpen,
    clearSelection: selection.clear,
  });
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
  });

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
    if (row?.type !== "group" || row.sharedWithMe) return;
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
    const key =
      row?.type === "group" && !row.sharedWithMe
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
    nextUnread: () => {
      cursor.enterKeyMode();
      goNextUnread();
    },
    newSession: () => newSession(startGroupOf(cursorRow)),
    move: () => openMove(keyTargets()),
    select: () => {
      if (cursorSession) selection.toggle(cursorSession.root.id);
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
          done: () => {
            const targets = keyTargets();
            if (targets.length === 0) return;
            if (targets.every((s) => s.readState === "done")) actions.backToInbox(targets);
            else actions.done(targets);
          },
          later: () => {
            const targets = keyTargets();
            if (targets.length === 0 || !cursorRow) return;
            if (targets.every((s) => s.readState === "later")) actions.backToInbox(targets);
            else menuAtRow(cursorRow.key, "later", cursorSession ?? targets[0], targets);
          },
          read: () => {
            const targets = keyTargets();
            if (targets.length > 0) actions.toggleRead(targets);
          },
        }
      : {}),
    // A peek card or a tooltip takes the first Escape (it marks it handled).
    // Then Escape clears the selection, then the search.
    clear: selection.selectionMode ? selection.clear : searching ? () => setQuery("") : undefined,
  });

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
    cursor.place(key);
    if (row.type === "session" && (event.metaKey || event.ctrlKey)) {
      selection.toggle(row.session.root.id);
      return;
    }
    activate(row);
  });
  const onToggleSelect = useStableHandler((key: string) => {
    const row = rowsByKey.get(key);
    if (row?.type !== "session") return;
    cursor.place(key);
    focusTree();
    selection.toggle(row.session.root.id);
  });
  const onRowAuxClick = useStableHandler((key: string, event: MouseEvent) => {
    const row = rowsByKey.get(key);
    if (event.button !== 1 || row?.type !== "session") return;
    event.preventDefault();
    openSession(row.session.root.id, { newTab: true });
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
  const onPeekClose = useStableHandler(cursor.closePeek);

  const commandsApi: SessionsCommandsApi = {
    open: (id) => openSession(id),
    newSession: () => newSession(startGroupOf(cursorRow)),
    newSessionIn: () => dialogs.setPick({ purpose: "new" }),
    nextUnread: goNextUnread,
    move: openMove,
    rename: () => dialogs.setRenameOpen(true),
    triage: actions,
    later: (session) => {
      const id = session.root.id;
      const row = navRows.find((r) => r.type === "session" && r.session.root.id === id);
      menuAtRow(row?.key ?? null, "later", session, [session]);
    },
    legacy: () => onViewChange("legacy"),
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
        const mine = row.type === "group" && !row.sharedWithMe;
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
          />
        );
      }
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
          onKeyDown={onKeyDown}
          onFocus={cursor.onFocus}
          onBlur={cursor.onBlur}
          onPointerDown={onTreePointerDown}
          className="group/tree min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1.5 pb-4 outline-none"
        >
          {segmentsOf(rows).map(({ section, rows: segmentRows }) =>
            section ? (
              // Screen readers hear the section when the cursor enters its rows.
              // biome-ignore lint/a11y/useSemanticElements: a tree groups its items with role="group"; a fieldset is a form control group
              <div
                key={section.key}
                role="group"
                aria-label={`${section.label}, ${section.count} ${section.unit ?? "session"}${section.count === 1 ? "" : "s"}`}
                aria-describedby={describedBy(section.key)}
              >
                <SectionHeader label={section.label} count={section.count} />
                {segmentRows.map(renderRow)}
              </div>
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
  // The bar goes with the selection: the focus goes back to the list.
  const andFocus = (run: () => void) => () => {
    run();
    focusTree();
  };
  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      {selected.length > 0 ? (
        <BulkBar
          count={selected.length}
          canTriage={canTriage}
          anyUnread={selected.some((session) => session.readState === "unread")}
          onDone={andFocus(() => actions.done(selected))}
          onLater={({ left, bottom }) =>
            dialogs.setMenu({
              x: left,
              y: bottom + 4,
              kind: "later",
              session: selected[0],
              targets: selected,
            })
          }
          onToggleRead={andFocus(() => actions.toggleRead(selected))}
          onMove={() => openMove(selected)}
          onClear={andFocus(selection.clear)}
        />
      ) : null}
      <SidebarSearch
        value={query}
        onChange={setQuery}
        inputRef={searchRef}
        onLeave={() => {
          focusTree();
          if (searching) cursor.moveTo(0);
        }}
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
