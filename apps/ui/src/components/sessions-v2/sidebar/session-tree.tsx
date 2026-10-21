/**
 * The sessions v2 sidebar tree (plan Phase 4, SPEC R4 to R6, R9, R10.3):
 * Inbox, Later, Done, No group, My groups, and Shared with me, with server
 * counts, paged rows, read state, and triage from the row menu and keys.
 *
 * The parts: `useTreeRows` (data and the flat row list), `useTreeFolds`,
 * `useTreeCursor` (keys, focus, the hover-card peek), `useTreeTriage`
 * (actions, Undo). This file holds the selection, the menus, the key map,
 * and the render.
 */

import { CircleAlert } from "lucide-react";
import { type MouseEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useUsers } from "@/api/hooks/use-users";
import type { SessionListItem } from "@/api/types";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useStableHandler } from "@/hooks/use-stable-handler";
import { SESSIONS_TOAST_POSITION } from "@/lib/sessions-v2";
import { useListKeys } from "../use-list-keys";
import { GroupNode } from "./group-node";
import { EmptyRow, LoadingRow, PagingRow } from "./list-state-rows";
import { RowMenu, type RowMenuState } from "./row-menu";
import { SectionHeader } from "./section-header";
import { SessionRow } from "./session-row";
import { SnoozeDateDialog } from "./snooze-picker";
import {
  type ContainerId,
  foldId,
  isNavRow,
  type NavRow,
  type TreeRow as TreeRowModel,
} from "./tree-rows";
import { useTreeCursor } from "./use-tree-cursor";
import { useTreeFolds } from "./use-tree-folds";
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

interface SessionTreeProps {
  /** The session in the focused pane, or the New session tab. */
  focused: string;
  openSession: (id: string, options?: { newTab?: boolean }) => void;
  /** Open the New session tab. Phase 5 passes the group to start in. */
  newSession: () => void;
  /** "View all N": open the list in the group tab (`?view=`). */
  setView: (view: string) => void;
}

export function SessionTree({ focused, openSession, newSession, setView }: SessionTreeProps) {
  const { userId } = useCurrentUser();
  const me = userId ?? null;
  const now = useMinuteClock();
  const [expanded, setExpanded] = useState<ReadonlySet<ContainerId>>(() => new Set());
  const { isOpen, setOpen, prune } = useTreeFolds(me);
  const { treeQuery, groups, rows } = useTreeRows({ me, isOpen, expanded });
  useEffect(() => {
    if (groups) prune(groups);
  }, [groups, prune]);

  const users = useUsers({ enabled: (groups?.sharedWithMe.length ?? 0) > 0 });
  const nameOf = useCallback(
    (id: string) => users.data?.find((user) => user.id === id)?.name ?? "Someone",
    [users.data],
  );

  const navRows = useMemo(() => rows.filter(isNavRow), [rows]);
  const rowsByKey = useMemo(() => new Map(navRows.map((row) => [row.key, row])), [navRows]);
  const baseId = useId();
  const domId = useCallback((key: string) => `${baseId}${encodeURIComponent(key)}`, [baseId]);
  const treeRef = useRef<HTMLDivElement>(null);
  const focusTree = () => treeRef.current?.focus({ preventScroll: true });

  // ── Menus ──────────────────────────────────────────────────────────────
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const [dateFor, setDateFor] = useState<SessionListItem[] | null>(null);
  // "Pick a date and time…" opens the dialog at once: it takes the focus from the closing menu.
  const pickingDate = useRef(false);
  /** The menu is gone: the focus goes back to the list, unless the date dialog holds it. */
  const onMenuClosed = () => {
    if (pickingDate.current) pickingDate.current = false;
    else focusTree();
  };

  const cursor = useTreeCursor({ navRows, focused, treeRef, domId, menuOpen: menu !== null });
  const { cursorRow, cursorIndex, keyboard } = cursor;

  // ── Selection: only rows on screen count, so a row that left (a fold, a
  // poll, another client) never keeps selection mode on.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const activeSelected = useMemo(() => {
    const visible = new Set<string>();
    for (const row of rows) if (row.type === "session") visible.add(row.session.root.id);
    return new Set([...selected].filter((id) => visible.has(id)));
  }, [rows, selected]);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const sessionsOf = (ids: ReadonlySet<string>) => {
    const found = new Map<string, SessionListItem>();
    for (const row of rows) {
      if (row.type === "session" && ids.has(row.session.root.id)) {
        found.set(row.session.root.id, row.session);
      }
    }
    return [...found.values()];
  };
  /** What a key acts on: the selection, else the cursor's session. */
  const keyTargets = (): SessionListItem[] => {
    if (activeSelected.size > 0) return sessionsOf(activeSelected);
    return cursorRow?.type === "session" ? [cursorRow.session] : [];
  };
  /** What a row's menu acts on: the selection when the row is in it, else the row. */
  const menuTargets = (session: SessionListItem): SessionListItem[] =>
    activeSelected.has(session.root.id) ? sessionsOf(activeSelected) : [session];

  const { canTriage, actions } = useTreeTriage({
    openSession,
    clearSelection,
    pickDate: (sessions) => {
      pickingDate.current = true;
      setDateFor(sessions);
    },
  });

  /** Open the row menu (or its Later part) under the cursor row, for the keys. */
  const menuAtCursor = (kind: RowMenuState["kind"], targets: SessionListItem[]) => {
    if (!cursorRow || targets.length === 0) return;
    const rect = document.getElementById(domId(cursorRow.key))?.getBoundingClientRect();
    setMenu({
      x: (rect?.left ?? 0) + 24,
      y: (rect?.bottom ?? 0) + 2,
      kind,
      session: cursorRow.type === "session" ? cursorRow.session : targets[0],
      targets,
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
    else if (row.type === "more") setExpanded((prev) => new Set(prev).add(row.container));
    else if (row.type === "all") setView(row.container);
    else toggleRow(row);
  };
  const toggleSelect = useStableHandler((id: string) => {
    const next = new Set(activeSelected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  });
  const cursorSession = cursorRow?.type === "session" ? cursorRow.session : null;

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
      const count = navRows.length;
      for (let step = 1; step <= count; step++) {
        const at = (Math.max(cursorIndex, 0) + step) % count;
        const row = navRows[at];
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
    },
    newSession,
    ...(canTriage
      ? {
          menu: () => {
            if (cursorSession) menuAtCursor("row", menuTargets(cursorSession));
          },
          select: () => {
            if (cursorSession) toggleSelect(cursorSession.root.id);
          },
          done: () => {
            const targets = keyTargets();
            if (targets.length === 0) return;
            if (targets.every((s) => s.readState === "done")) actions.backToInbox(targets);
            else actions.done(targets);
          },
          later: () => {
            const targets = keyTargets();
            if (targets.length === 0) return;
            if (targets.every((s) => s.readState === "later")) actions.backToInbox(targets);
            else menuAtCursor("later", targets);
          },
          read: () => {
            const targets = keyTargets();
            if (targets.length > 0) actions.toggleRead(targets);
          },
          // A peek card or a tooltip takes the first Escape (it marks it handled).
          clear: activeSelected.size > 0 ? clearSelection : undefined,
        }
      : {}),
  });

  // ── Pointer handlers: stable, so the memoized rows render only on change.
  const onRowClick = useStableHandler((key: string, event: MouseEvent) => {
    const row = rowsByKey.get(key);
    if (!row) return;
    cursor.place(key);
    if (row.type === "session" && canTriage && (event.metaKey || event.ctrlKey)) {
      toggleSelect(row.session.root.id);
      return;
    }
    activate(row);
  });
  const onRowAuxClick = useStableHandler((key: string, event: MouseEvent) => {
    const row = rowsByKey.get(key);
    if (event.button !== 1 || row?.type !== "session") return;
    event.preventDefault();
    openSession(row.session.root.id, { newTab: true });
  });
  const onRowContextMenu = useStableHandler((key: string, event: MouseEvent) => {
    const row = rowsByKey.get(key);
    if (row?.type !== "session" || !canTriage) return;
    event.preventDefault();
    cursor.place(key);
    const targets = menuTargets(row.session);
    setMenu({ x: event.clientX, y: event.clientY, kind: "row", session: row.session, targets });
  });
  const onToggle = useStableHandler((key: string) => {
    const row = rowsByKey.get(key);
    if (!row) return;
    cursor.place(key);
    toggleRow(row);
  });
  const onNewSession = useStableHandler(newSession);
  const onPeekClose = useStableHandler(cursor.closePeek);

  if (treeQuery.isPending) {
    return (
      <div aria-busy="true" className="flex flex-col gap-2 px-4 py-3">
        {["a", "b", "c", "d"].map((key) => (
          <Skeleton key={key} className="h-4 w-full" />
        ))}
      </div>
    );
  }
  if (!treeQuery.data) {
    return (
      <EmptyState
        compact
        icon={CircleAlert}
        title="Couldn't load sessions."
        description={treeQuery.error?.message}
      />
    );
  }

  /** The id of the empty or loading line that describes a row or a section. */
  const stateId = (parentKey: string) => `${domId(parentKey)}-state`;
  const described = new Set<string>();
  for (const row of rows)
    if (row.type === "empty" || row.type === "loading") described.add(row.parentKey);
  const describedBy = (key: string) => (described.has(key) ? stateId(key) : undefined);
  const selectionMode = activeSelected.size > 0;

  const renderRow = (row: TreeRowModel) => {
    switch (row.type) {
      case "section":
        return null;
      case "box":
      case "group":
      case "owner": {
        const takesNewSession =
          (row.type === "box" && row.id === "nogroup") ||
          (row.type === "group" && !row.sharedWithMe);
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
            onNewSession={takesNewSession ? onNewSession : undefined}
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
            selected={activeSelected.has(id)}
            showCheckbox={selectionMode || (keyboard && isCursor)}
            canTriage={canTriage}
            peek={cursor.peekKey === row.key}
            keyboard={keyboard}
            nameOf={nameOf}
            onRowClick={onRowClick}
            onRowAuxClick={onRowAuxClick}
            onRowContextMenu={onRowContextMenu}
            onToggleSelect={toggleSelect}
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
      case "empty":
        return (
          <EmptyRow
            key={row.key}
            id={stateId(row.parentKey)}
            level={row.level}
            kind={row.kind}
            showHint={canTriage}
          />
        );
      case "loading":
        return <LoadingRow key={row.key} id={stateId(row.parentKey)} level={row.level} />;
    }
  };

  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      <div
        ref={treeRef}
        role="tree"
        aria-label="Sessions"
        aria-multiselectable={canTriage || undefined}
        aria-activedescendant={cursorRow ? domId(cursorRow.key) : undefined}
        aria-busy={rows.some((row) => row.type === "loading") || undefined}
        tabIndex={0}
        data-kb={keyboard ? "true" : undefined}
        onKeyDown={onKeyDown}
        onFocus={cursor.onFocus}
        onBlur={cursor.onBlur}
        onPointerDown={cursor.onPointerDown}
        className="group/tree min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1.5 pb-4 outline-none"
      >
        {segmentsOf(rows).map(({ section, rows: segmentRows }) =>
          section ? (
            // Screen readers hear the section when the cursor enters its rows.
            // biome-ignore lint/a11y/useSemanticElements: a tree groups its items with role="group"; a fieldset is a form control group
            <div
              key={section.key}
              role="group"
              aria-label={`${section.label}, ${section.count} ${section.count === 1 ? "session" : "sessions"}`}
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
      <RowMenu
        state={menu}
        actions={actions}
        onClose={() => setMenu(null)}
        onRestoreFocus={onMenuClosed}
      />
      <SnoozeDateDialog
        open={dateFor !== null}
        onOpenChange={(open) => {
          if (!open) setDateFor(null);
        }}
        onSnooze={(at) => {
          if (dateFor) actions.later(dateFor, at);
          setDateFor(null);
        }}
        onRestoreFocus={focusTree}
      />
    </TooltipProvider>
  );
}
