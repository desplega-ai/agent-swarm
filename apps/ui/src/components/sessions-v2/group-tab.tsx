/**
 * The group tab (plan Phase 8, D2, SPEC R6): "View all N" opens the full list
 * of a section or a group (`?view=`). A `DataGrid` with the title, group,
 * people, activity, and time, `ListPager` server paging by 50, a
 * `SegmentedControl` filter (All, Unread, Running, Needs you), and a search
 * box scoped to the list (`ListFilterBar`). Below `md` the phone group
 * screen draws the rows (`phoneList`, `MobileList` rows with swipe and
 * long-press), and the title, the search, and the filter go in its top bar
 * as one row (`phoneBar`): the search is an icon that opens the field, and
 * the filter is a button that opens a bottom sheet. A row click, or Enter
 * on a row, opens the session in a tab next to this one.
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
import { ChevronDown, Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useSessionLabels } from "@/api/hooks/use-session-tree";
import { sessionsQueryOptions } from "@/api/hooks/use-sessions";
import { useUsers } from "@/api/hooks/use-users";
import type { SessionListItem } from "@/api/types";
import { AvatarStack } from "@/components/comb/presence-avatars";
import { DataGridColumnsMenu } from "@/components/shared/columns-menu";
import { DataGrid, HIDE_WHEN_COMPACT, useDataGridColumns } from "@/components/shared/data-grid";
import { ListFilterBar } from "@/components/shared/list-filter-bar";
import { ListPager, resolveListPage } from "@/components/shared/list-pager";
import { SearchBox } from "@/components/shared/search-box";
import { TaskSourceMark, taskSourceLabel } from "@/components/shared/task-source-mark";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useIsPhone } from "@/hooks/use-mobile";
import { useStableHandler } from "@/hooks/use-stable-handler";
import { useWithinAllUsersScope } from "@/lib/all-users-scope";
import { peerColor } from "@/lib/comb/presence";
import { chatSourceOf, groupCrumb } from "@/lib/session-groups";
import { useSessionsFilter } from "@/lib/sessions-show";
import { sidebarListParams, userName } from "@/lib/sessions-v2";
import { cn, formatRelativeTime, sessionDisplayTitle } from "@/lib/utils";
import { GroupCrumbIcon } from "./group-crumb-icon";
import { GroupTabStar } from "./group-tab-star";
import { ActionSheet, ActionSheetCheck } from "./mobile/action-sheet";
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
  /**
   * The phone group screen's top bar. Set (also to null, before it mounts):
   * the title, the search, and the filter show there as one row.
   */
  phoneBar?: HTMLElement | null;
}

/** The name of a list (a section or a group) for the people who read it. */
function useListTitle(view: string) {
  const { userId } = useCurrentUser();
  const { data: users } = useUsers();
  const labels = useSessionLabels();
  const section = sectionTab(view);
  return {
    section,
    title: section?.title ?? groupCrumb(view, userId ?? null, (id) => userName(users, id), labels),
  };
}

/** The title of a list: its icon, its name, its session count, and the star of a group. */
export function GroupTitle({ view, count }: { view: string; count?: number }) {
  const { section, title } = useListTitle(view);
  const SectionIcon = section?.icon;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <h2 className="flex min-w-0 items-center gap-1.5 text-base font-semibold">
        {SectionIcon ? (
          <SectionIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <GroupCrumbIcon
            groupKey={view}
            noGroup={false}
            className="size-4 text-muted-foreground"
          />
        )}
        <span className="truncate">{title}</span>
        <span className="font-mono text-xs font-normal tabular-nums text-muted-foreground">
          {count ?? ""}
        </span>
      </h2>
      <GroupTabStar groupKey={section ? null : view} />
    </div>
  );
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
  phoneBar,
}: GroupTabProps & { listKey: string }) {
  const { userId } = useCurrentUser();
  const me = userId ?? null;
  // The list query reads the filter (Mine / All, hidden sources): re-render on a change.
  useSessionsFilter();
  const phone = useIsPhone();
  const { data: users } = useUsers();
  const nameOf = (id: string) => userName(users, id);
  const labels = useSessionLabels();
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

  const { section, title } = useListTitle(view);
  // The phone top bar: the search icon opened the field, and the filter sheet.
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Later and Done never hold an unread session: a session that wakes or gets news goes back to the Inbox.
  const noUnread = view === "later" || view === "done";

  const { limit: _sidebarLimit, ...base } = sidebarListParams(view);
  const keepPrevious = useWithinAllUsersScope(keepPreviousData);
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
    // Never across a scope change: the kept page could hold all-users rows.
    placeholderData: keepPrevious,
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

  const gridColumns = useDataGridColumns("sessions-group");
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
          const chat = chatSourceOf(p.data.root);
          return (
            <span className="flex h-full min-w-0 items-center gap-2">
              <ReadMark unread={unread} />
              {unread ? <span className="sr-only">Unread. </span> : null}
              {chat ? (
                <>
                  <TaskSourceMark source={chat} className="text-muted-foreground" />
                  <span className="sr-only">From {taskSourceLabel(chat)}. </span>
                </>
              ) : null}
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
        valueGetter: (p) => (p.data ? groupCrumb(p.data.groupKey, me, nameOf, labels) : ""),
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
    [me, users, labels],
  );

  const setFilter = (next: Filter) => setState((prev) => ({ ...prev, filter: next, page: 0 }));
  const options: { value: Filter; label: string; disabled?: boolean; tooltip?: string }[] = [
    { value: "all", label: "All" },
    {
      value: "unread",
      label: "Unread",
      disabled: noUnread,
      tooltip: noUnread ? `Sessions in ${title} are never unread.` : undefined,
    },
    { value: "running", label: "Running" },
    { value: "needs", label: "Needs you" },
  ];
  const filterLabel = options.find((option) => option.value === filter)?.label ?? "All";
  const searchPlaceholder = `Search ${section ? title : "this group"}`;
  const count = list.data ? total : undefined;
  // Search mode on a phone: the icon opened the field, or it holds text.
  const searching = searchOpen || text !== "";

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-3 px-5 pt-4 pb-3", className)}>
      {phoneBar === undefined ? (
        <>
          <GroupTitle view={view} count={count} />
          <ListFilterBar
            searchValue={text}
            onSearchChange={setText}
            searchPlaceholder={searchPlaceholder}
            // A narrow pane: the filter wraps under the field before the placeholder cuts.
            searchClassName="w-full min-w-48 sm:max-w-sm sm:flex-1"
          >
            <SegmentedControl<Filter>
              aria-label="Show"
              value={filter}
              onValueChange={setFilter}
              options={options}
            />
            <div className="ml-auto">
              <DataGridColumnsMenu state={gridColumns} />
            </div>
          </ListFilterBar>
        </>
      ) : (
        <>
          {phoneBar
            ? createPortal(
                searching ? (
                  <search
                    className="flex min-w-0 flex-1 items-center gap-1"
                    // The field kept its text and takes the focus again: an emptied field stays.
                    onFocus={(event) => {
                      if (event.target === searchRef.current) setSearchOpen(true);
                    }}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                        setSearchOpen(false);
                    }}
                  >
                    <SearchBox
                      value={text}
                      onChange={setText}
                      placeholder={searchPlaceholder}
                      inputRef={searchRef}
                      clearable
                      // A 44 px field with 16 px text (iOS does not zoom in), and a
                      // 44 px tap area on the 28 px clear button.
                      className="flex-1 [&_button]:after:absolute [&_button]:after:-inset-2 [&_input]:h-11 [&_input]:rounded-lg [&_input]:bg-muted/60 [&_input]:text-base"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-11 px-2 text-base text-primary"
                      onClick={() => {
                        setText("");
                        setSearchOpen(false);
                      }}
                    >
                      Cancel
                    </Button>
                  </search>
                ) : (
                  <>
                    <div className="flex min-w-0 flex-1">
                      <GroupTitle view={view} count={count} />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={searchPlaceholder}
                      // The field shows first, so it takes the focus in the same tap
                      // (iOS opens the keyboard only from the tap itself).
                      onClick={() => {
                        flushSync(() => setSearchOpen(true));
                        searchRef.current?.focus();
                      }}
                      className="size-11 shrink-0"
                    >
                      <Search className="size-5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-haspopup="dialog"
                      aria-label={`Show: ${filterLabel}`}
                      onClick={() => setFilterOpen(true)}
                      className={cn(
                        "h-11 shrink-0 gap-1 px-2 text-base font-medium",
                        filter === "all" ? "text-muted-foreground" : "text-primary",
                      )}
                    >
                      {filterLabel}
                      <ChevronDown aria-hidden className="size-4" />
                    </Button>
                  </>
                ),
                phoneBar,
              )
            : null}
          <ActionSheet open={filterOpen} onOpenChange={setFilterOpen} title="Show">
            <div role="radiogroup" aria-label="Show" className="flex flex-col">
              {options.map((option) => (
                <ActionSheetCheck
                  key={option.value}
                  role="radio"
                  checked={filter === option.value}
                  disabled={option.disabled}
                  label={option.label}
                  hint={option.tooltip}
                  onSelect={() => {
                    setFilter(option.value);
                    setFilterOpen(false);
                  }}
                />
              ))}
            </div>
          </ActionSheet>
        </>
      )}
      {phone ? (
        (phoneList?.(rows, { loading: list.isPending, label: title }) ?? null)
      ) : (
        <DataGrid
          rowData={rows}
          columnDefs={columns}
          columns={gridColumns}
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
