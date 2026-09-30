import { useQueryClient } from "@tanstack/react-query";
import {
  CloudOff,
  Lock,
  MessageSquare,
  MessageSquarePlus,
  RefreshCw,
  SearchX,
  X,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  addAgentFsComment,
  agentFsCommentsKey,
  agentFsCommentsQuery,
  useAgentFsAccess,
  useAgentFsComments,
} from "@/api/hooks/use-agent-fs";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCommentAnchors } from "@/hooks/use-comment-anchors";
import { useConfig } from "@/hooks/use-config";
import { useMediaQuery } from "@/hooks/use-media-query";
import type {
  CommentAddParams,
  CommentEntry,
  CommentListEntry,
  StatResult,
} from "@/lib/agent-fs/types";
import type { AnchorResolution } from "@/lib/comb/comment-anchor";
import { COMMENT_LIST_MAX, commentAuthorNames } from "@/lib/comb/comments";
import type { DomTextSpace } from "@/lib/comb/dom-text-space";
import { browserStorage, type OutboxEntry, sweepExpiredDrafts } from "@/lib/comb/drafts";
import { getFileKind } from "@/lib/comb/file-kinds";
import type { DrivePath } from "@/lib/comb/paths";
import {
  type CommentFilter,
  countByFilter,
  type FilterFacts,
  filterThreads,
  isQueryEmpty,
  searchNeedle,
  threadMatchesFilter,
  threadMatchesSearch,
} from "@/lib/comb/thread-filter";
import type { ThreadSwarmState } from "@/lib/comb/thread-status";
import {
  CommentComposer,
  type ComposerExtrasContext,
  READ_ONLY_MESSAGE,
  useHasDraft,
} from "./comment-composer";
import {
  CommentContextProvider,
  type CommentContextValue,
  useCommentContext,
} from "./comment-context";
import { CommentHighlights } from "./comment-highlights";
import { CommentThread } from "./comment-thread";
import { PassageMarkers } from "./passage-markers";
import { QuoteExcerpt } from "./quote-excerpt";
import {
  CommentSearch,
  FilterMenu,
  FilterSummary,
  PendingSummary,
  SearchToggle,
} from "./rail-filters";
import { SelectionCommentButton } from "./selection-comment-button";
import { useAuthorLabel } from "./use-author-label";
import { type CommentOutbox, useCommentOutbox } from "./use-comment-outbox";
import { useDomTextSpace } from "./use-dom-text-space";
import { useThreadSwarmStates } from "./use-thread-swarm-states";

type RailTab = "open" | "resolved";

const NO_THREADS: CommentListEntry[] = [];

// The rail sits beside the viewer from `lg` up. Below that it is a bottom sheet.
const WIDE_QUERY = "(min-width: 1024px)";

/** Scroll the viewer pane to a comment's passage. False when it has none. */
function scrollToPassage(
  space: DomTextSpace | null,
  anchor: AnchorResolution | undefined,
  reduceMotion: boolean,
) {
  if (!space || anchor?.start == null || anchor.end == null) return false;
  const target =
    space.blocksFor(anchor.start, anchor.end)[0] ??
    space.toRange(anchor.start, anchor.end)?.startContainer.parentElement;
  target?.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  return target != null;
}

export interface CommentRailProps {
  file: DrivePath;
  stat: StatResult;
  /** The viewer's scroll pane: selection, anchors, and highlights live in it. */
  viewerRef: RefObject<HTMLElement | null>;
  /** Thread actions mount point: step-9 "Send to swarm", step-10 "Review changes". */
  threadActions?: (thread: CommentListEntry) => ReactNode;
  /**
   * Rail header mount point: step-9 "Send N to swarm". `open` = the open
   * threads. It shows in the "N pending" summary, which is there only while
   * pending comments exist.
   */
  railHeaderActions?: (ctx: { file: DrivePath; open: CommentListEntry[] }) => ReactNode;
  /** Composer mount point: step-8 mention picker. Every composer of the file gets it. */
  renderComposerExtras?: (ctx: ComposerExtrasContext) => ReactNode;
  /**
   * step-10: read-only (a 403 on a write), owned by the page so the rail and
   * the review share it.
   */
  readOnly: boolean;
  onReadOnly: () => void;
  /**
   * step-10: URL params that put something other than the file in the viewer
   * pane (`diff`, the review). Selecting a card removes them in the same
   * navigation, so the thread shows in the file. When one is set, the
   * narrow-layout sheet closes and a deep link does not open it.
   */
  viewerParams?: readonly string[];
}

/**
 * Comments on one file: the right-hand rail (Open / Resolved threads, search
 * and filters, the "N pending" summary, a file-level composer, the "Not sent"
 * outbox), the text-selection "Comment" button, and the passage highlights
 * and processing markers in the viewer pane. Below `lg` the rail is a bottom
 * sheet.
 *
 * The search and the filter are local state, not URL params: typing would
 * write the URL on every key, and a deep link (`?comment=`) must always show
 * its thread. The rail mounts per file, so they reset on a new file.
 */
export function CommentRail({
  file,
  stat,
  viewerRef,
  threadActions,
  railHeaderActions,
  renderComposerExtras,
  readOnly,
  onReadOnly,
  viewerParams,
}: CommentRailProps) {
  const access = useAgentFsAccess();
  const { apiUrl } = useConfig().config;
  const query = useAgentFsComments(file);
  const threads = query.data?.threads ?? NO_THREADS;
  const open = useMemo(() => threads.filter((thread) => !thread.resolved), [threads]);
  const resolved = useMemo(() => threads.filter((thread) => thread.resolved), [threads]);
  const authorNames = useMemo(() => commentAuthorNames(threads), [threads]);
  const queryClient = useQueryClient();
  const reduceMotion = useReducedMotion() ?? false;

  // Search and filters. The same match decides the list and the highlights.
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<CommentFilter>("all");
  const authorLabel = useAuthorLabel(file);
  const authorName = useCallback(
    (entry: CommentEntry) => entry.authorDisplayName || authorLabel(entry.author),
    [authorLabel],
  );
  const states = useThreadSwarmStates(open);
  const facts = useMemo<FilterFacts>(
    () => ({ me: access.userId, states }),
    [access.userId, states],
  );
  const needle = searchNeedle(search);
  const shownOpen = useMemo(
    () => filterThreads(open, { needle, filter }, facts, authorName),
    [open, needle, filter, facts, authorName],
  );
  const shownResolved = useMemo(
    () => filterThreads(resolved, { needle, filter }, facts, authorName),
    [resolved, needle, filter, facts, authorName],
  );
  const clearFilters = useCallback(() => {
    setSearch("");
    setFilter("all");
  }, []);

  // Expired drafts of any file go once the rail mounts.
  useEffect(() => sweepExpiredDrafts(browserStorage(), Date.now()), []);

  const scope = useMemo(
    () => ({
      apiUrl,
      endpoint: access.endpoint,
      userId: access.userId ?? "",
      orgId: file.orgId,
      driveId: file.driveId,
      path: file.path,
    }),
    [apiUrl, access.endpoint, access.userId, file.orgId, file.driveId, file.path],
  );
  const outbox = useCommentOutbox(scope, {
    send: async (params: CommentAddParams) => {
      await addAgentFsComment(access, file, params);
      void queryClient.invalidateQueries({ queryKey: agentFsCommentsKey(access, file) });
    },
    // Fresh, not paused while offline, and no retries: an offline retry fails fast.
    fetchThreads: async () =>
      (
        await queryClient.fetchQuery({
          ...agentFsCommentsQuery(access, file),
          staleTime: 0,
          retry: false,
          networkMode: "always",
        })
      ).threads,
  });

  // Anchors: resolve every thread against the text the viewer shows.
  const space = useDomTextSpace(viewerRef);
  const anchors = useCommentAnchors(file, threads, space, stat.currentVersion);

  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<RailTab>("open");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; from: "doc" | "card" } | null>(null);
  const [pending, setPending] = useState<Range | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const wide = useMediaQuery(WIDE_QUERY);

  // The `?comment=` link this rail has already selected (and scrolled to).
  const linkRef = useRef<{ id: string; scrolled: boolean } | null>(null);

  // step-10: what the viewer pane shows instead of the file ("" = the file).
  const viewerState = viewerParams?.map((name) => searchParams.get(name) ?? "").join("") ?? "";

  const activate = useCallback(
    (id: string) => {
      setActiveId(id);
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          next.set("comment", id);
          // step-10: leave the review in the same navigation.
          for (const name of viewerParams ?? []) next.delete(name);
          return next;
        },
        { replace: true },
      );
      if (viewerState) {
        // step-10: the file renders next. The deep-link effect scrolls to the
        // passage once it resolves.
        linkRef.current = { id, scrolled: false };
        setSheetOpen(false);
        return;
      }
      linkRef.current = { id, scrolled: true };
      const anchor = anchors.get(id);
      if (scrollToPassage(space, anchor, reduceMotion)) setSheetOpen(false);
      else if (anchor?.status === "lost") {
        toast.info("The text this comment pointed to is no longer in the file.");
      }
    },
    [anchors, space, reduceMotion, setSearchParams, viewerParams, viewerState],
  );

  // Deep link `?comment=<id>`: once the thread loads, open its tab (and the
  // sheet on narrow layouts) and select it. Scroll to its passage as soon as
  // the passage resolves. A search or filter that hides it is cleared.
  const linkedId = searchParams.get("comment");
  useEffect(() => {
    if (!linkedId) return;
    let link = linkRef.current;
    if (link?.id !== linkedId) {
      const thread = threads.find((t) => t.id === linkedId);
      if (!thread) return;
      setTab(thread.resolved ? "resolved" : "open");
      setActiveId(linkedId);
      if (
        !threadMatchesFilter(thread, filter, facts) ||
        !threadMatchesSearch(thread, needle, authorName)
      ) {
        clearFilters();
      }
      if (!wide && !viewerState) setSheetOpen(true);
      link = { id: linkedId, scrolled: false };
      linkRef.current = link;
    }
    if (!link.scrolled && scrollToPassage(space, anchors.get(linkedId), reduceMotion)) {
      link.scrolled = true;
    }
  }, [
    linkedId,
    threads,
    anchors,
    space,
    wide,
    reduceMotion,
    viewerState,
    filter,
    facts,
    needle,
    authorName,
    clearFilters,
  ]);

  // step-10: a review opened (from "Review changes" in the sheet): the sheet gives way to it.
  useEffect(() => {
    if (viewerState) setSheetOpen(false);
  }, [viewerState]);

  // Keep the selected or doc-hovered card in view in the rail.
  const listRef = useRef<HTMLDivElement>(null);
  const focusId = hover?.from === "doc" ? hover.id : activeId;
  useEffect(() => {
    if (!focusId) return;
    listRef.current
      ?.querySelector(`[data-comment-id="${CSS.escape(focusId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  // Back online: send what is waiting.
  const { retryAll } = outbox;
  useEffect(() => {
    const onOnline = () => void retryAll();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [retryAll]);

  // The page matches the list: only the open threads the search and the
  // filter show are painted, pending ones in their own style, processing
  // ones with a marker.
  const paintIds = useMemo(() => new Set(shownOpen.map((thread) => thread.id)), [shownOpen]);
  const [pendingIds, processingIds] = useMemo(() => {
    const byKind = { pending: new Set<string>(), processing: new Set<string>() };
    for (const thread of shownOpen) {
      const state = states.get(thread.id);
      if (state) byKind[state.kind].add(thread.id);
    }
    return [byKind.pending, byKind.processing] as const;
  }, [shownOpen, states]);
  const pendingCount = useMemo(
    () => open.filter((thread) => states.get(thread.id)?.kind === "pending").length,
    [open, states],
  );
  // The selected card stays emphasized only while the list shows it.
  const activeShown = useMemo(
    () =>
      activeId !== null &&
      (shownOpen.some((thread) => thread.id === activeId) ||
        shownResolved.some((thread) => thread.id === activeId)),
    [activeId, shownOpen, shownResolved],
  );
  const emphasizedIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeId && activeShown) ids.add(activeId);
    if (hover?.from === "card") ids.add(hover.id);
    return ids;
  }, [activeId, activeShown, hover]);

  const context = useMemo<CommentContextValue>(
    () => ({
      file,
      scope,
      outbox,
      readOnly,
      markReadOnly: onReadOnly,
      authorNames,
      renderComposerExtras,
    }),
    [file, scope, outbox, readOnly, onReadOnly, authorNames, renderComposerExtras],
  );

  const counts = useMemo(
    () => countByFilter(tab === "open" ? open : resolved, needle, facts, authorName),
    [tab, open, resolved, needle, facts, authorName],
  );
  const railQuery: RailQuery = {
    search,
    onSearch: setSearch,
    filter,
    onFilter: setFilter,
    counts,
    active: !isQueryEmpty({ needle, filter }),
    clear: clearFilters,
  };

  const rail = (
    <RailBody
      tab={tab}
      onTabChange={setTab}
      open={shownOpen}
      resolved={shownResolved}
      totals={{ open: open.length, resolved: resolved.length }}
      query={railQuery}
      states={states}
      pendingCount={pendingCount}
      onShowPending={() => {
        if (filter === "pending") {
          setFilter("all");
        } else {
          setFilter("pending");
          setTab("open");
        }
      }}
      truncated={query.data?.truncated ?? false}
      loading={query.isPending}
      // A failed poll keeps the threads it already has on screen.
      error={query.data === undefined ? query.error : null}
      anchors={anchors}
      activeId={activeId}
      hoveredId={hover?.from === "doc" ? hover.id : null}
      onActivate={activate}
      onCardHover={(id) => setHover(id ? { id, from: "card" } : null)}
      canAnchor={space !== null}
      listRef={listRef}
      header={railHeaderActions?.({ file, open })}
      threadActions={threadActions}
    />
  );
  const notSent = outbox.entries.length;

  return (
    <CommentContextProvider value={context}>
      <CommentHighlights
        rootRef={viewerRef}
        space={space}
        anchors={anchors}
        paintIds={paintIds}
        pendingIds={pendingIds}
        emphasizedIds={emphasizedIds}
        pending={pending}
        onHover={(id) =>
          setHover((current) =>
            id ? { id, from: "doc" } : current?.from === "doc" ? null : current,
          )
        }
        onActivate={activate}
      />
      <PassageMarkers rootRef={viewerRef} space={space} anchors={anchors} ids={processingIds} />
      <SelectionCommentButton rootRef={viewerRef} space={space} onPendingChange={setPending} />
      {wide ? (
        <aside
          aria-label="Comments"
          className="flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card xl:w-80"
        >
          {rail}
        </aside>
      ) : (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="fixed right-4 bottom-4 z-30 shadow-sm"
              aria-label={`Comments (${open.length} open${notSent ? `, ${notSent} not sent` : ""})`}
            >
              {notSent ? <CloudOff className="text-status-error-strong" /> : <MessageSquare />}
              {open.length + notSent}
            </Button>
          </SheetTrigger>
          <SheetContent
            side="bottom"
            className="max-h-[80dvh] gap-0 p-0"
            aria-describedby={undefined}
          >
            <SheetHeader className="border-b border-border">
              <SheetTitle>Comments</SheetTitle>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col">{rail}</div>
          </SheetContent>
        </Sheet>
      )}
    </CommentContextProvider>
  );
}

/** The rail's search and filter (local state of `CommentRail`). */
interface RailQuery {
  search: string;
  onSearch: (search: string) => void;
  filter: CommentFilter;
  onFilter: (filter: CommentFilter) => void;
  /** Threads per filter in the current tab, with the search applied. */
  counts: Record<CommentFilter, number>;
  /** The search or the filter hides threads. */
  active: boolean;
  clear: () => void;
}

interface RailBodyProps {
  tab: RailTab;
  onTabChange: (tab: RailTab) => void;
  /** The open threads the search and the filter show. */
  open: CommentListEntry[];
  /** The resolved threads the search and the filter show. */
  resolved: CommentListEntry[];
  /** All threads per tab, before the search and the filter. */
  totals: Record<RailTab, number>;
  query: RailQuery;
  states: ReadonlyMap<string, ThreadSwarmState>;
  /** Open `@swarm` threads not sent yet (all of them, not only the shown ones). */
  pendingCount: number;
  /** "N pending": show the pending threads (or all again). */
  onShowPending: () => void;
  /** Only the newest `COMMENT_LIST_MAX` threads are listed. */
  truncated: boolean;
  loading: boolean;
  error: Error | null;
  anchors: Map<string, AnchorResolution>;
  activeId: string | null;
  hoveredId: string | null;
  onActivate: (id: string) => void;
  onCardHover: (id: string | null) => void;
  /** The file shows text, so a selection can anchor a comment. */
  canAnchor: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  header: ReactNode;
  threadActions?: (thread: CommentListEntry) => ReactNode;
}

function RailBody({
  tab,
  onTabChange,
  open,
  resolved,
  totals,
  query,
  states,
  pendingCount,
  onShowPending,
  truncated,
  loading,
  error,
  anchors,
  activeId,
  hoveredId,
  onActivate,
  onCardHover,
  canAnchor,
  listRef,
  header,
  threadActions,
}: RailBodyProps) {
  const { readOnly, renderComposerExtras } = useCommentContext();
  // A saved file-level draft reopens its composer (after a reload).
  const hasFileDraft = useHasDraft({ kind: "file" });
  const [composing, setComposing] = useState(hasFileDraft);
  const threads = tab === "open" ? open : resolved;
  // The body remounts when the sheet reopens or the layout changes: a search
  // that is still on keeps its field open.
  const [searchOpen, setSearchOpen] = useState(() => query.search !== "");
  const bodyRef = useRef<HTMLDivElement>(null);

  // A closed file-level composer gives focus back to its button.
  const fileButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (composing || !restoreFocus.current) return;
    restoreFocus.current = false;
    fileButtonRef.current?.focus();
  }, [composing]);

  // Closing the search clears it.
  const { onSearch } = query;
  const closeSearch = useCallback(
    (refocus: boolean) => {
      setSearchOpen(false);
      onSearch("");
      if (refocus) {
        requestAnimationFrame(() =>
          bodyRef.current?.querySelector<HTMLElement>("[data-comb-search-toggle]")?.focus(),
        );
      }
    },
    [onSearch],
  );

  return (
    <>
      <div ref={bodyRef} className="flex shrink-0 flex-col gap-2 border-b border-border-subtle p-3">
        <Tabs value={tab} onValueChange={(value) => onTabChange(value as RailTab)}>
          <TabsList className="w-full">
            <TabsTrigger value="open">
              Open <span className="text-muted-foreground tabular-nums">{open.length}</span>
            </TabsTrigger>
            <TabsTrigger value="resolved">
              Resolved <span className="text-muted-foreground tabular-nums">{resolved.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1">
          {readOnly ? (
            <p className="flex flex-1 items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0" aria-hidden />
              {READ_ONLY_MESSAGE}
            </p>
          ) : (
            <Button
              ref={fileButtonRef}
              size="sm"
              variant="outline"
              className="mr-1 flex-1"
              onClick={() => setComposing(true)}
              disabled={composing}
            >
              <MessageSquarePlus />
              Comment on file
            </Button>
          )}
          <SearchToggle
            open={searchOpen}
            active={query.search.trim() !== ""}
            onToggle={() => (searchOpen ? closeSearch(false) : setSearchOpen(true))}
          />
          <FilterMenu value={query.filter} counts={query.counts} onChange={query.onFilter} />
        </div>
        {searchOpen ? (
          <CommentSearch
            value={query.search}
            onChange={query.onSearch}
            onClose={() => closeSearch(true)}
          />
        ) : null}
        {composing ? (
          <CommentComposer
            target={{ kind: "file" }}
            placeholder="Comment on this file"
            autoFocus
            onClose={() => {
              restoreFocus.current = true;
              setComposing(false);
            }}
            renderComposerExtras={renderComposerExtras}
          />
        ) : null}
      </div>
      {pendingCount > 0 ? (
        <PendingSummary
          count={pendingCount}
          showing={query.filter === "pending"}
          onShow={onShowPending}
        >
          {/* Rail header actions mount point (step-9 Send N to swarm). */}
          {header}
        </PendingSummary>
      ) : null}
      {/* Both tabs: a comment that did not post is never out of sight. */}
      <OutboxList />
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing the newest {COMMENT_LIST_MAX.toLocaleString()} threads.
          </p>
        ) : null}
        {query.active && !loading && !error && threads.length > 0 ? (
          <FilterSummary
            filter={query.filter}
            shown={threads.length}
            total={totals[tab]}
            onClear={query.clear}
          />
        ) : null}
        {loading ? (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </>
        ) : error ? (
          <p className="text-xs text-status-error-strong">{error.message}</p>
        ) : threads.length === 0 && query.active && totals[tab] > 0 ? (
          <EmptyState
            icon={SearchX}
            title="No matching comments"
            description={
              totals[tab] === 1
                ? `The ${tab} comment does not match.`
                : `None of the ${totals[tab]} ${tab} comments match.`
            }
            action={
              <Button size="sm" onClick={query.clear}>
                Clear filters
              </Button>
            }
          />
        ) : threads.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title={tab === "open" ? "No open comments" : "No resolved comments"}
            description={
              tab === "open" && !readOnly
                ? canAnchor
                  ? "Select text to comment on a passage, or comment on the whole file."
                  : "Comment on the whole file."
                : undefined
            }
          />
        ) : (
          threads.map((thread) => (
            <CommentThread
              key={thread.id}
              thread={thread}
              anchor={anchors.get(thread.id)}
              active={thread.id === activeId}
              hovered={thread.id === hoveredId}
              onActivate={onActivate}
              onHover={onCardHover}
              actions={threadActions?.(thread)}
              swarmState={states.get(thread.id)}
            />
          ))
        )}
      </div>
    </>
  );
}

/**
 * Comments that failed to post (network error or 5xx), with Retry and
 * Discard. The live region stays mounted, so a new entry is announced.
 */
function OutboxList() {
  const { outbox } = useCommentContext();
  const { entries, sending } = outbox;
  return (
    <div aria-live="polite" aria-atomic={false}>
      {entries.length > 0 ? (
        <section
          aria-label="Not sent"
          className="flex max-h-60 flex-col gap-2 overflow-y-auto border-b border-border-subtle p-3"
        >
          {entries.length > 1 ? (
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-status-error-strong">
                {entries.length} not sent
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void outbox.retryAll()}
                disabled={sending.size === entries.length}
              >
                <RefreshCw />
                Retry all
              </Button>
            </div>
          ) : null}
          {entries.map((entry) => (
            <OutboxCard
              key={entry.id}
              entry={entry}
              outbox={outbox}
              sending={sending.has(entry.id)}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function OutboxCard({
  entry,
  outbox,
  sending,
}: {
  entry: OutboxEntry;
  outbox: CommentOutbox;
  /** This tab is sending it now: Retry and Discard wait. */
  sending: boolean;
}) {
  const { file } = useCommentContext();
  const label = `${sending ? "Sending" : "Not sent"}${entry.params.parentId ? " (reply)" : ""}`;
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-dashed border-status-error/40 bg-surface p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              // biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the tooltip, so keyboard users can read why it was not sent
              tabIndex={0}
              className="flex items-center gap-1.5 rounded-sm font-medium text-status-error-strong outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <CloudOff className="size-3.5" aria-hidden />
              {label}
            </span>
          </TooltipTrigger>
          <TooltipContent>{entry.error}</TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void outbox.retry(entry.id)}
            disabled={sending}
          >
            <RefreshCw />
            Retry
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Discard"
            disabled={sending}
            onClick={() => outbox.discard(entry.id)}
          >
            <X />
          </Button>
        </div>
      </div>
      {entry.params.quote?.exact ? (
        <QuoteExcerpt
          text={entry.params.quote.exact}
          mono={getFileKind(file.path) !== "markdown"}
        />
      ) : null}
      <p className="whitespace-pre-wrap break-words text-sm">{entry.params.body}</p>
    </article>
  );
}
