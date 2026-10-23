/**
 * The group tab (plan Phase 8, D2, SPEC R6): "View all N" opens the full list
 * of a section or a group (`?view=`). A `DataGrid` with the title, group,
 * people, activity, and time, `ListPager` server paging by 50, a
 * `SegmentedControl` filter (All, Unread, Running, Needs you), and a search
 * box scoped to the list (`ListFilterBar`). Below `md` the phone group
 * screen draws the rows (`phoneList`, `MobileList` rows with swipe and
 * long-press), with 44 px controls. A row click, or Enter on a row, opens
 * the session in a tab next to this one.
 *
 * The page, the filter, and the search live per connection, user, and list
 * for the page session (outside the component), so a trip to a session and
 * back keeps them. A page past the end (a list that shrank) moves back to
 * the last page, as the Tasks list does.
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type {
  CellKeyDownEvent,
  ColDef,
  FullWidthCellKeyDownEvent,
  RowClickedEvent,
} from "ag-grid-community";
import { Hash } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { sessionsQueryOptions } from "@/api/hooks/use-sessions";
import { useUsers } from "@/api/hooks/use-users";
import type { SessionListItem } from "@/api/types";
import { AvatarStack } from "@/components/comb/presence-avatars";
import { DataGrid, HIDE_WHEN_COMPACT } from "@/components/shared/data-grid";
import { ListFilterBar } from "@/components/shared/list-filter-bar";
import { ListPager, resolveListPage } from "@/components/shared/list-pager";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useIsPhone } from "@/hooks/use-mobile";
import { useStableHandler } from "@/hooks/use-stable-handler";
import { peerColor } from "@/lib/comb/presence";
import { groupCrumb } from "@/lib/session-groups";
import { useSessionsFilter } from "@/lib/sessions-show";
import { sidebarListParams, userName } from "@/lib/sessions-v2";
import { cn, formatRelativeTime, sessionDisplayTitle } from "@/lib/utils";
import { ActivityMark, activityOf, shortAgo } from "./sidebar/session-row";
import { ReadMark, UNREAD_TITLE } from "./sidebar/tree-row";
import { sectionTab } from "./tabs/tab-info";
import { TruncatedTitle } from "./truncated-title";

const PAGE_SIZE = 50;
const PAGE_SIZES = [PAGE_SIZE] as const;

type Filter = "all" | "unread" | "running" | "needs";

interface ListState {
  page: number;
  filter: Filter;
  q: string;
}

const FIRST: ListState = { page: 0, filter: "all", q: "" };
/**
 * Per connection, user, and list, for the page session: a remount (a trip to
 * a session tab) keeps the place. Written from an effect, never in render.
 */
const lists = new Map<string, ListState>();

/** The people of a row other than me. */
function othersOf(session: SessionListItem, me: string | null) {
  return (session.people ?? []).filter((person) => person.id !== me);
}

/** The phone rows of the list: the page's sessions, while it loads, and the list's name. */
export type PhoneGroupList = (
  rows: SessionListItem[] | undefined,
  state: { loading: boolean; label: string },
) => ReactNode;

interface GroupTabProps {
  view: string;
  onOpen: (rootTaskId: string) => void;
  /** Replaces the outer padding (the phone screen). */
  className?: string;
  /** The rows below `md` (the phone group screen). */
  phoneList?: PhoneGroupList;
}

export function GroupTab(props: GroupTabProps) {
  const { config } = useConfig();
  const { userId } = useCurrentUser();
  // A new connection, user, or list starts from its own kept state.
  const listKey = `${config.apiUrl} ${userId ?? ""} ${props.view}`;
  return <GroupList key={listKey} listKey={listKey} {...props} />;
}

function GroupList({
  listKey,
  view,
  onOpen,
  className,
  phoneList,
}: GroupTabProps & { listKey: string }) {
  const { userId } = useCurrentUser();
  const me = userId ?? null;
  // The list query reads the filter (Mine / All, hidden sources): re-render on a change.
  useSessionsFilter();
  const phone = useIsPhone();
  const { data: users } = useUsers();
  const nameOf = (id: string) => userName(users, id);
  const [state, setState] = useState(() => lists.get(listKey) ?? FIRST);
  const { page, filter, q } = state;
  useEffect(() => {
    lists.set(listKey, state);
  }, [listKey, state]);
  const [text, setText] = useState(q);
  const query = useDebouncedValue(text.trim(), 250);
  // A new search starts at its first page.
  useEffect(() => {
    setState((prev) => (prev.q === query ? prev : { ...prev, q: query, page: 0 }));
  }, [query]);

  const section = sectionTab(view);
  const title = section?.title ?? groupCrumb(view, me, nameOf);
  const Icon = section?.icon ?? Hash;
  // Later and Done never hold an unread session: a session that wakes or gets news goes back to the Inbox.
  const noUnread = view === "later" || view === "done";

  const { limit: _sidebarLimit, ...base } = sidebarListParams(view);
  // The last page stays on screen while the next one loads: no blank grid, no "0 sessions".
  const list = useQuery({
    ...sessionsQueryOptions(me, {
      ...base,
      ...(filter === "unread" ? { triage: "unread" as const } : {}),
      ...(filter === "running" || filter === "needs" ? { status: filter } : {}),
      q: q || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    placeholderData: keepPreviousData,
  });
  const total = list.data?.total ?? 0;
  // A kept page past the end of a list that shrank moves back to its last page.
  const shown = resolveListPage(
    page,
    PAGE_SIZE,
    list.isPlaceholderData ? undefined : list.data?.total,
  );
  useEffect(() => {
    if (shown.stale) setState((prev) => ({ ...prev, page: shown.page }));
  }, [shown.stale, shown.page]);
  const rows = list.data?.sessions;

  // Stable: the grid keeps its handlers, and the tab list behind `onOpen` changes.
  const onRowClicked = useStableHandler((event: RowClickedEvent<SessionListItem>) => {
    if (event.data) onOpen(event.data.root.id);
  });
  const onCellKeyDown = useStableHandler(
    (event: CellKeyDownEvent<SessionListItem> | FullWidthCellKeyDownEvent<SessionListItem>) => {
      const key = (event.event as KeyboardEvent | null)?.key;
      if (key === "Enter" && event.data) onOpen(event.data.root.id);
    },
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: nameOf reads `users`, rebuilt each render
  const columns = useMemo(
    // No column sorts: the grid holds one page of 50, and a sort of one page reads like a sort of all.
    // A narrow pane (the split) drops Group, then People, then Activity, so the
    // grid never scrolls sideways: Title and Time always stay (UX review R9).
    (): ColDef<SessionListItem>[] => [
      {
        headerName: "Title",
        colId: "title",
        flex: 1,
        minWidth: 200,
        sortable: false,
        valueGetter: (p) => (p.data ? sessionDisplayTitle(p.data.root) : ""),
        cellRenderer: (p: { data?: SessionListItem }) => {
          if (!p.data) return null;
          const unread = p.data.readState === "unread";
          return (
            <span className="flex h-full min-w-0 items-center gap-2">
              <ReadMark unread={unread} />
              {unread ? <span className="sr-only">Unread. </span> : null}
              <TruncatedTitle
                title={sessionDisplayTitle(p.data.root)}
                className={unread ? UNREAD_TITLE : "text-muted-foreground"}
              />
            </span>
          );
        },
      },
      {
        headerName: "Group",
        colId: "group",
        width: 180,
        context: { ...HIDE_WHEN_COMPACT, compactHidePriority: 0 },
        sortable: false,
        valueGetter: (p) => (p.data ? groupCrumb(p.data.groupKey, me, nameOf) : ""),
        cellClass: "text-muted-foreground",
      },
      {
        headerName: "People",
        colId: "people",
        width: 120,
        context: { ...HIDE_WHEN_COMPACT, compactHidePriority: 1 },
        sortable: false,
        cellRenderer: (p: { data?: SessionListItem }) => {
          const others = p.data ? othersOf(p.data, me) : [];
          if (others.length === 0) return null;
          return (
            <span className="flex h-full items-center">
              <AvatarStack
                size="xs"
                max={3}
                label={others.map((person) => person.name).join(", ")}
                peers={others.map((person) => ({
                  id: person.id,
                  name: person.name,
                  color: peerColor(person.id),
                  doing: "",
                }))}
              />
            </span>
          );
        },
      },
      {
        headerName: "Activity",
        colId: "activity",
        width: 104,
        context: { ...HIDE_WHEN_COMPACT, compactHidePriority: 2 },
        sortable: false,
        cellRenderer: (p: { data?: SessionListItem }) =>
          p.data ? (
            <span className="flex h-full items-center">
              <ActivityMark activity={activityOf(p.data)} />
            </span>
          ) : null,
      },
      {
        headerName: "Time",
        colId: "time",
        width: 80,
        sortable: false,
        valueGetter: (p) => p.data?.lastActivityAt ?? "",
        cellRenderer: (p: { data?: SessionListItem }) =>
          p.data ? (
            <span
              title={formatRelativeTime(p.data.lastActivityAt)}
              className="font-mono text-meta tabular-nums text-muted-foreground"
            >
              {shortAgo(p.data.lastActivityAt, Date.now())}
            </span>
          ) : null,
      },
    ],
    [me, users],
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-3 px-5 pt-4 pb-3", className)}>
      <h2 className="flex min-w-0 items-center gap-1.5 text-base font-semibold">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{title}</span>
        <span className="font-mono text-xs font-normal tabular-nums text-muted-foreground">
          {list.data ? total : ""}
        </span>
      </h2>
      <ListFilterBar
        searchValue={text}
        onSearchChange={setText}
        searchPlaceholder={`Search ${section ? title : "this group"}`}
        // A phone: a 44 px field with 16 px text (iOS does not zoom in). A narrow
        // pane: the filter wraps under the field before the placeholder cuts.
        searchClassName={
          phone
            ? "w-full [&_input]:h-11 [&_input]:text-base"
            : "w-full min-w-48 sm:max-w-sm sm:flex-1"
        }
      >
        <SegmentedControl<Filter>
          aria-label="Show"
          // A phone: 44 px options (the frame adds its 2 px inset and 1 px border).
          className={phone ? "h-12.5 [&_[role=radio]]:min-w-11" : undefined}
          value={filter}
          onValueChange={(next) => setState((prev) => ({ ...prev, filter: next, page: 0 }))}
          options={[
            { value: "all", label: "All" },
            {
              value: "unread",
              label: "Unread",
              disabled: noUnread,
              tooltip: noUnread ? `Sessions in ${title} are never unread.` : undefined,
            },
            { value: "running", label: "Running" },
            { value: "needs", label: "Needs you" },
          ]}
        />
      </ListFilterBar>
      {phone ? (
        (phoneList?.(rows, { loading: list.isPending, label: title }) ?? null)
      ) : (
        <DataGrid
          rowData={rows}
          columnDefs={columns}
          loading={list.isPending}
          emptyMessage={q || filter !== "all" ? "No sessions match." : "No sessions here."}
          pagination={false}
          columnSizing="flex"
          getRowId={(p) => p.data.root.id}
          onRowClicked={onRowClicked}
          // Rows take the focus: the arrow keys move, and Enter opens the session.
          cellFocus
          onCellKeyDown={onCellKeyDown}
        />
      )}
      <ListPager
        page={shown.page}
        pageSize={PAGE_SIZE}
        total={total}
        pageSizeOptions={PAGE_SIZES}
        onPageChange={(next) => setState((prev) => ({ ...prev, page: next }))}
        onPageSizeChange={() => {}}
        emptyLabel="0 sessions"
        // A phone: 44 px previous and next buttons.
        touch={phone}
      />
    </div>
  );
}
