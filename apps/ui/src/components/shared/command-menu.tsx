import { defaultFilter, useCommandState } from "cmdk";
import type { LucideIcon } from "lucide-react";
import {
  CornerDownLeft,
  History,
  Loader2,
  PauseCircle,
  PlayCircle,
  Plus,
  Search,
  UserPlus,
  XCircle,
} from "lucide-react";
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type RouteObject, useLocation, useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useVersionGate } from "@/api/hooks/use-feature-gate";
import {
  useCancelTask,
  usePauseTask,
  useResumeTask,
  useTask,
  useTasks,
} from "@/api/hooks/use-tasks";
import type { AgentTask } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import {
  PALETTE_SCOPES,
  type PaletteScopeId,
  SEARCH_PROVIDERS,
  type SearchProvider,
} from "@/components/command-palette/providers";
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { navRequirementMet } from "@/lib/agent-fs/state";
import { modKeyLabel } from "@/lib/approval-shortcuts";
import {
  highlightParts,
  isWordMatch,
  type Match,
  matchText,
  type Range,
  rankResults,
} from "@/lib/command-palette/match";
import { pushRecent, type RecentItem, readRecents } from "@/lib/command-palette/recents";
import {
  type NavEntry,
  navEntries,
  type PaletteNav,
  SEARCH_PROVIDER_IDS,
  type SearchProviderId,
} from "@/lib/command-palette/route-meta";
import { usePaletteIdentity } from "@/lib/command-palette/use-palette-identity";
import { getConfig } from "@/lib/config";
import { useRuntimePoolsGate } from "@/lib/runtime-pools";
import { taskListTitle } from "@/lib/task-title";
import { useIsAdmin } from "@/lib/use-can";
import { cn } from "@/lib/utils";

/** One command a page adds to the palette. */
export interface CommandMenuItem {
  /** Unique in its group. */
  id: string;
  label: string;
  icon?: LucideIcon;
  /** More words the palette filter matches. */
  keywords?: string[];
  /** A key hint at the right of the row, e.g. "E". */
  shortcut?: string;
  onSelect: () => void;
}

interface CommandMenuGroupEntry {
  id: string;
  heading: string;
  items: CommandMenuItem[];
}

type RegisterGroup = (id: string, group: CommandMenuGroupEntry | null) => void;

interface SearchState {
  search: string;
  setSearch: (value: string) => void;
}

interface OpenState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

// Separate contexts, so a page that registers commands never re-renders when
// the registered groups change (that would register again, in a loop).
const RegisterContext = createContext<RegisterGroup | null>(null);
const GroupsContext = createContext<CommandMenuGroupEntry[]>([]);
const SearchContext = createContext<SearchState | null>(null);
const OpenContext = createContext<OpenState | null>(null);
const RoutesContext = createContext<readonly RouteObject[]>([]);

/**
 * Hands the router's route table to the palette. `App` mounts it around the
 * `RouterProvider`: the palette lives inside the routes, so it cannot import
 * the table without an import cycle.
 */
export function CommandMenuRoutesProvider({
  routes,
  children,
}: {
  routes: readonly RouteObject[];
  children: ReactNode;
}) {
  return <RoutesContext.Provider value={routes}>{children}</RoutesContext.Provider>;
}

/** Holds the page command groups, the palette's search text and its open state. Mount it around the routes and `CommandMenu`. */
export function CommandMenuProvider({ children }: { children: ReactNode }) {
  const [groups, setGroups] = useState<CommandMenuGroupEntry[]>([]);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const register = useCallback<RegisterGroup>((id, group) => {
    setGroups((prev) => {
      const at = prev.findIndex((entry) => entry.id === id);
      if (!group) return at < 0 ? prev : prev.filter((entry) => entry.id !== id);
      if (at < 0) return [...prev, group];
      const next = [...prev];
      next[at] = group;
      return next;
    });
  }, []);
  const searchValue = useMemo(() => ({ search, setSearch }), [search]);
  const openValue = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <RegisterContext.Provider value={register}>
      <GroupsContext.Provider value={groups}>
        <OpenContext.Provider value={openValue}>
          <SearchContext.Provider value={searchValue}>{children}</SearchContext.Provider>
        </OpenContext.Provider>
      </GroupsContext.Provider>
    </RegisterContext.Provider>
  );
}

/**
 * Adds a group of commands to the palette while the caller is mounted. An
 * empty `items` list hides the group. Memoize `items`: a new array registers
 * the group again. With `enabled` false the caller leaves the group alone,
 * so another caller can own the same id (the sessions page hands the
 * `sessions` group to the v2 view).
 */
export function useCommandMenuGroup(
  id: string,
  heading: string,
  items: CommandMenuItem[],
  enabled = true,
) {
  const register = useContext(RegisterContext);
  useEffect(() => {
    if (enabled) register?.(id, items.length > 0 ? { id, heading, items } : null);
  }, [register, id, heading, items, enabled]);
  // React runs every cleanup before any new effect, so a hand-over between
  // two callers never drops the other caller's group.
  useEffect(() => {
    if (!enabled) return;
    return () => register?.(id, null);
  }, [register, id, enabled]);
}

/** The palette's search text, without a type prefix. Empty while the palette is closed. */
export function useCommandMenuSearch(): string {
  return parseScope(useContext(SearchContext)?.search ?? "").query;
}

/** Opens the palette (the header's search button). */
export function useOpenCommandMenu(): () => void {
  const setOpen = useContext(OpenContext)?.setOpen;
  return useCallback(() => setOpen?.(true), [setOpen]);
}

function useRequired<T>(value: T | null): T {
  if (!value) throw new Error("CommandMenu needs a CommandMenuProvider around it");
  return value;
}

// --- Type filter ---------------------------------------------------------

/** `task:`, `files:`, `mcp:` ... at the start of the text scopes the search. */
const SCOPE_ALIASES = new Map<string, PaletteScopeId>(
  PALETTE_SCOPES.filter((scope) => scope.id !== "all").flatMap((scope) => {
    const plural = scope.label.toLowerCase();
    const singular = plural.endsWith("s") ? plural.slice(0, -1) : plural;
    return [plural, singular, scope.id].map((alias) => [alias, scope.id] as const);
  }),
);

function parseScope(text: string): { scope: PaletteScopeId | null; query: string } {
  const match = /^\s*([a-z-]+):\s*/i.exec(text);
  const scope = match ? SCOPE_ALIASES.get(match[1].toLowerCase()) : undefined;
  return scope && match
    ? { scope, query: text.slice(match[0].length) }
    : { scope: null, query: text };
}

// --- Gates ---------------------------------------------------------------

type Gate = Pick<PaletteNav, "adminOnly" | "minVersion" | "requires">;

/** The sidebar's gates for a route or provider: admin, API version, runtime switch. */
function usePaletteGate(): (gate: Gate | undefined) => boolean {
  const isAdmin = useIsAdmin();
  const versionOk = useVersionGate();
  const { data: status } = useStatusContext();
  const runtimePools = useRuntimePoolsGate().open;
  return (gate) => {
    if (!gate) return true;
    if (gate.adminOnly && !isAdmin) return false;
    if (gate.minVersion && !versionOk(gate.minVersion)) return false;
    if (gate.requires === "comb") return navRequirementMet("comb", status?.agent_fs?.comb);
    if (gate.requires === "runtime-pools") return runtimePools;
    return true;
  };
}

// --- Rows ----------------------------------------------------------------

function Highlighted({ text, ranges }: { text: string; ranges: readonly Range[] }) {
  if (ranges.length === 0) return <>{text}</>;
  return (
    <>
      {highlightParts(text, ranges).map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-[2px] bg-primary/15 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

interface RowProps {
  value: string;
  icon?: LucideIcon;
  title: string;
  ranges?: readonly Range[];
  /** Muted text after the title ("Settings"). */
  parent?: string;
  /** Muted text at the right ("in progress"). */
  detail?: string;
  /** A second line (file content match). */
  below?: ReactNode;
  shortcut?: string;
  /** Where it goes: Mod+Enter opens it in a new tab and adds it to recents. */
  target?: OpenTarget;
  onSelect: () => void;
}

function Row({
  value,
  icon: Icon,
  title,
  ranges = [],
  parent,
  detail,
  below,
  shortcut,
  target,
  onSelect,
}: RowProps) {
  return (
    <CommandItem
      value={value}
      data-href={target?.href}
      data-kind={target?.kind}
      data-title={target?.title}
      data-detail={target?.detail}
      onSelect={onSelect}
      className="group/item gap-3 sm:py-2!"
    >
      {Icon ? <Icon className="size-4" /> : <span className="size-4 shrink-0" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate group-data-[selected=true]/item:whitespace-normal group-data-[selected=true]/item:wrap-anywhere">
            <Highlighted text={title} ranges={ranges} />
          </span>
          {parent ? <span className="shrink-0 text-xs text-muted-foreground">{parent}</span> : null}
        </span>
        {below ? <span className="truncate text-xs text-muted-foreground">{below}</span> : null}
      </span>
      {detail ? (
        <span className="ml-2 max-w-[40%] shrink-0 truncate text-xs text-muted-foreground max-sm:hidden">
          {detail}
        </span>
      ) : null}
      {shortcut ? <CommandShortcut>{shortcut}</CommandShortcut> : null}
    </CommandItem>
  );
}

function GroupHeading({ label, loading }: { label: string; loading?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      {label}
      {loading ? <Loader2 aria-label="Searching" className="size-3 animate-spin" /> : null}
    </span>
  );
}

// --- Provider groups -------------------------------------------------------

interface OpenTarget {
  kind: string;
  title: string;
  href: string;
  detail?: string;
}

const ALL_SCOPE_LIMIT = 5;
const SCOPED_LIMIT = 20;

/** One provider's group. Mounted only while it should search, so its query runs only then. */
function ProviderGroup({
  id,
  provider,
  query,
  scoped,
  onOpen,
  onLoading,
}: {
  id: SearchProviderId;
  provider: SearchProvider;
  query: string;
  scoped: boolean;
  onOpen: (target: OpenTarget) => void;
  onLoading: (id: SearchProviderId, loading: boolean) => void;
}) {
  const limit = scoped ? SCOPED_LIMIT : ALL_SCOPE_LIMIT;
  // Ask for a few extra rows: the client matcher can drop some.
  const state = provider.useSearch(query, limit + 3);
  useEffect(() => {
    onLoading(id, state.loading);
    return () => onLoading(id, false);
  }, [id, state.loading, onLoading]);
  const rows = rankResults(state.results, query, provider.clientMatch).slice(0, limit);
  if (rows.length === 0 && !state.loading && !state.error) return null;
  return (
    <CommandGroup heading={<GroupHeading label={provider.label} loading={state.loading} />}>
      {rows.map(({ result, match }) => (
        <Row
          key={result.id}
          value={`${id}:${result.id}`}
          icon={provider.icon}
          title={result.title}
          ranges={match.ranges}
          detail={result.detail}
          below={
            result.snippet ? (
              <Highlighted
                text={result.snippet.map((part) => part.text).join("")}
                ranges={snippetRanges(result.snippet)}
              />
            ) : undefined
          }
          target={{ kind: id, title: result.title, href: result.href, detail: result.detail }}
          onSelect={() =>
            onOpen({ kind: id, title: result.title, href: result.href, detail: result.detail })
          }
        />
      ))}
      {rows.length === 0 && state.loading ? (
        <div className="px-2 py-1.5">
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      ) : null}
      {state.error && rows.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          Could not search {provider.label.toLowerCase()}.
        </p>
      ) : null}
    </CommandGroup>
  );
}

function snippetRanges(parts: { text: string; hit: boolean }[]): Range[] {
  const ranges: Range[] = [];
  let at = 0;
  for (const part of parts) {
    if (part.hit) ranges.push([at, at + part.text.length]);
    at += part.text.length;
  }
  return ranges;
}

// --- The palette -----------------------------------------------------------

const GO_TO_LIMIT = 6;
const ACTION_LIMIT = 6;
const ACTIONABLE = new Set(["pending", "in_progress", "paused"]);
const FINISHED = new Set(["completed", "failed", "cancelled", "superseded"]);

/**
 * A task action (pause, resume, cancel) shows only when the text names its
 * verb: "deploy" must not put "Cancel deploy task" on the Enter key.
 */
function namesVerb(query: string, verb: string): boolean {
  const target = verb.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .some((term) => term.length >= 2 && target.startsWith(term));
}

function selectedItem(list: HTMLElement | null): HTMLElement | null {
  return list?.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]') ?? null;
}

export function CommandMenu() {
  const { open, setOpen } = useRequired(useContext(OpenContext));
  const { setSearch } = useRequired(useContext(SearchContext));

  // Every close path clears the search, so the palette always opens empty.
  const close = useCallback(() => {
    setOpen(false);
    setSearch("");
  }, [setOpen, setSearch]);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (openRef.current) close();
        else setOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, setOpen]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      title="Command palette"
      description="Search pages, tasks, agents, workflows, files and actions"
      showCloseButton={false}
      className="top-[12vh] translate-y-0 sm:max-w-2xl max-sm:top-2 max-sm:max-w-[calc(100%-1rem)]"
      commandProps={{ shouldFilter: false, loop: true }}
    >
      {/* Radix unmounts the content while closed: no palette query runs then. */}
      {open ? <PaletteSession close={close} /> : null}
    </CommandDialog>
  );
}

/**
 * The palette for one swarm and user. A switch, in this tab or another,
 * remounts the body: recents, scope chip and search observers start fresh,
 * so nothing the previous user saw stays on screen. The typed text goes too.
 */
function PaletteSession({ close }: { close: () => void }) {
  const { setSearch } = useRequired(useContext(SearchContext));
  const identity = usePaletteIdentity(getConfig);
  const shown = useRef(identity);
  useEffect(() => {
    if (shown.current === identity) return;
    shown.current = identity;
    setSearch("");
  }, [identity, setSearch]);
  return <PaletteBody key={identity} close={close} />;
}

function PaletteBody({ close }: { close: () => void }) {
  const { search, setSearch } = useRequired(useContext(SearchContext));
  const pageGroups = useContext(GroupsContext);
  const routes = useContext(RoutesContext);
  const navigate = useNavigate();
  const location = useLocation();
  const gate = usePaletteGate();
  const listRef = useRef<HTMLDivElement>(null);
  const [recents, setRecents] = useState<RecentItem[]>(() => readRecents(getConfig()));

  const [chipScope, setChipScope] = useState<PaletteScopeId>("all");
  const parsed = parseScope(search);
  const scope = parsed.scope ?? chipScope;
  const query = parsed.query.trim();
  // Server searches wait for a typing pause; client-side groups follow every key.
  const debounced = useDebouncedValue(query, 150);

  const nav = useMemo(() => navEntries(routes), [routes]);
  const visibleNav = nav.filter((entry) => gate(entry));
  const navByPath = useMemo(() => new Map(nav.map((entry) => [entry.path, entry])), [nav]);
  const providers = SEARCH_PROVIDER_IDS.filter((id) => gate(SEARCH_PROVIDERS[id].gate));
  const scopes = PALETTE_SCOPES.filter(
    (entry) =>
      entry.id === "all" || providers.some((id) => SEARCH_PROVIDERS[id].scope === entry.id),
  );

  const openTarget = useCallback(
    (target: OpenTarget, newTab: boolean) => {
      setRecents(pushRecent(getConfig(), target));
      if (newTab) {
        window.open(target.href, "_blank", "noopener,noreferrer");
        return;
      }
      close();
      void navigate(target.href);
    },
    [close, navigate],
  );

  function run(action: () => void) {
    close();
    action();
  }

  // Task actions: the open task, and any running task the search names.
  const activeTaskId = location.pathname.match(/^\/tasks\/([^/]+)/)?.[1] ?? "";
  const activeTask = useTask(activeTaskId).data;
  const { data: tasksData } = useTasks({ includeHeartbeat: true, limit: 100 });
  const { data: agents } = useAgents();
  const cancelTask = useCancelTask();
  const pauseTask = usePauseTask();
  const resumeTask = useResumeTask();

  function taskAction(action: "cancel" | "pause" | "resume", task: AgentTask) {
    run(() => {
      if (action === "cancel")
        cancelTask.mutate({ id: task.id, reason: "Cancelled from command palette" });
      else if (action === "pause") pauseTask.mutate(task.id);
      else resumeTask.mutate(task.id);
    });
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      const data = selectedItem(listRef.current)?.dataset;
      if (!data?.href) return;
      event.preventDefault();
      openTarget(
        {
          kind: data.kind ?? "nav",
          title: data.title ?? data.href,
          href: data.href,
          detail: data.detail,
        },
        true,
      );
      return;
    }
    if (event.key === "Tab" && scopes.length > 1) {
      event.preventDefault();
      const at = scopes.findIndex((entry) => entry.id === scope);
      const next = scopes[(at + (event.shiftKey ? -1 : 1) + scopes.length) % scopes.length];
      setChipScope(next.id);
      if (parsed.scope) setSearch(parsed.query);
      return;
    }
    if (event.key === "Backspace" && search === "" && chipScope !== "all") {
      event.preventDefault();
      setChipScope("all");
    }
  }

  const [loadingProviders, setLoadingProviders] = useState<ReadonlySet<SearchProviderId>>(
    () => new Set(),
  );
  const onProviderLoading = useCallback((id: SearchProviderId, loading: boolean) => {
    setLoadingProviders((prev) => {
      if (prev.has(id) === loading) return prev;
      const next = new Set(prev);
      if (loading) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const isAll = scope === "all";
  const navRows = isAll
    ? visibleNav
        .map((entry) => ({
          entry,
          match: matchText(entry.title, query, [entry.parent ?? "", ...(entry.keywords ?? [])]),
        }))
        .filter((row): row is { entry: NavEntry; match: Match } => row.match !== null)
        .sort((a, b) => (query ? b.match.score - a.match.score : 0))
        .slice(0, query ? GO_TO_LIMIT : undefined)
    : [];

  const pageRows = isAll
    ? pageGroups
        .map((group) => ({
          group,
          // cmdk's own scorer, as before the rebuild: page groups (sessions)
          // search the text themselves and expect a lenient filter.
          items: group.items.filter(
            (item) =>
              !query ||
              defaultFilter(`${group.heading} ${item.label} ${item.id}`, query, item.keywords) > 0,
          ),
        }))
        .filter((entry) => entry.items.length > 0)
    : [];

  const actionRows: RowProps[] = [];
  if (isAll) {
    const createTask = matchText("Create task", query, ["new task", "assign"]);
    if (createTask) {
      actionRows.push({
        value: "action:create-task",
        icon: Plus,
        title: "Create task",
        ranges: createTask.ranges,
        onSelect: () => run(() => void navigate("/tasks?new=true")),
      });
    }
    if (query) {
      for (const agent of agents ?? []) {
        const title = `Assign new task to ${agent.name}`;
        const match = matchText(title, query, [agent.role ?? ""]);
        if (!match || !isWordMatch(matchText(agent.name, query, [agent.role ?? ""]))) continue;
        const href = `/tasks?new=true&agentId=${encodeURIComponent(agent.id)}`;
        actionRows.push({
          value: `action:assign:${agent.id}`,
          icon: UserPlus,
          title,
          ranges: match.ranges,
          onSelect: () => run(() => void navigate(href)),
        });
        if (actionRows.length >= 3) break;
      }
      const actionable = (tasksData?.tasks ?? []).filter((task) => ACTIONABLE.has(task.status));
      for (const task of actionable) {
        const label = taskListTitle(task);
        const verbs: Array<["pause" | "resume" | "cancel", string, LucideIcon]> = [];
        if (task.status === "in_progress") verbs.push(["pause", "Pause", PauseCircle]);
        if (task.status === "paused") verbs.push(["resume", "Resume", PlayCircle]);
        if (task.status !== "paused") verbs.push(["cancel", "Cancel", XCircle]);
        for (const [action, verb, icon] of verbs) {
          if (!namesVerb(query, verb)) continue;
          const title = `${verb} ${label}`;
          const match = matchText(title, query, [task.id]);
          if (!match) continue;
          actionRows.push({
            value: `action:${action}:${task.id}`,
            icon,
            title,
            ranges: match.ranges,
            onSelect: () => taskAction(action, task),
          });
        }
        if (actionRows.length >= ACTION_LIMIT) break;
      }
    }
  }

  const currentTaskRows: RowProps[] = [];
  if (isAll && activeTask && !FINISHED.has(activeTask.status)) {
    const options: Array<[boolean, "pause" | "resume" | "cancel", string, LucideIcon, string]> = [
      [activeTask.status === "in_progress", "pause", "Pause current task", PauseCircle, "P"],
      [activeTask.status === "paused", "resume", "Resume current task", PlayCircle, "R"],
      [true, "cancel", "Cancel current task", XCircle, "C"],
    ];
    for (const [show, action, title, icon, shortcut] of options) {
      const match = show && (!query || namesVerb(query, action)) ? matchText(title, query) : null;
      if (!match) continue;
      currentTaskRows.push({
        value: `current:${action}`,
        icon,
        title,
        ranges: match.ranges,
        shortcut,
        onSelect: () => taskAction(action, activeTask),
      });
    }
  }

  const showRecents = isAll && !query && recents.length > 0;
  const activeProviders = providers.filter((id) => {
    const provider = SEARCH_PROVIDERS[id];
    if (!isAll && provider.scope !== scope) return false;
    const minQuery = isAll ? Math.max(provider.minQuery, 1) : provider.minQuery;
    return debounced.length >= minQuery;
  });
  const hasClientRows =
    showRecents ||
    pageRows.length > 0 ||
    navRows.length > 0 ||
    actionRows.length > 0 ||
    currentTaskRows.length > 0;
  const scopeLabel = scopes.find((entry) => entry.id === scope)?.label ?? "All";

  return (
    <div className="flex flex-col" onKeyDownCapture={onKeyDown}>
      <CommandInput
        autoFocus
        placeholder={isAll ? "Search or jump to…" : `Search ${scopeLabel.toLowerCase()}…`}
        value={search}
        onValueChange={setSearch}
      />
      {scopes.length > 1 ? (
        <div
          role="tablist"
          aria-label="Filter by type"
          className="flex gap-1 overflow-x-auto border-b border-border-subtle px-3 py-2 [scrollbar-width:none]"
        >
          {scopes.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === scope}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setChipScope(entry.id);
                if (parsed.scope) setSearch(parsed.query);
              }}
              className={cn(
                "shrink-0 rounded-md border px-2 py-0.5 text-xs transition-colors",
                entry.id === scope
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
      <CommandList ref={listRef} className="max-h-[min(480px,60vh)] scroll-pt-8 py-1">
        {showRecents ? (
          <CommandGroup heading="Recent">
            {recents.map((recent) => {
              const icon =
                recent.kind === "nav"
                  ? navByPath.get(recent.href)?.icon
                  : SEARCH_PROVIDERS[recent.kind as SearchProviderId]?.icon;
              return (
                <Row
                  key={recent.href}
                  value={`recent:${recent.href}`}
                  icon={icon ?? History}
                  title={recent.title}
                  detail={recent.detail}
                  target={recent}
                  onSelect={() => openTarget(recent, false)}
                />
              );
            })}
          </CommandGroup>
        ) : null}

        {/* Page commands first: they act on what the user is looking at. */}
        {pageRows.map(({ group, items }) => (
          <CommandGroup key={group.id} heading={group.heading}>
            {items.map((item) => (
              <Row
                key={item.id}
                value={`page:${group.id}:${item.id}`}
                icon={item.icon}
                title={item.label}
                ranges={matchText(item.label, query)?.ranges}
                shortcut={item.shortcut}
                onSelect={() => run(item.onSelect)}
              />
            ))}
          </CommandGroup>
        ))}

        {navRows.length > 0 ? (
          <CommandGroup heading="Go to">
            {navRows.map(({ entry, match }) => (
              <Row
                key={entry.path}
                value={`nav:${entry.path}`}
                icon={entry.icon}
                title={entry.title}
                ranges={match.ranges}
                parent={entry.parent}
                target={{ kind: "nav", title: entry.title, href: entry.path, detail: entry.parent }}
                onSelect={() =>
                  openTarget(
                    { kind: "nav", title: entry.title, href: entry.path, detail: entry.parent },
                    false,
                  )
                }
              />
            ))}
          </CommandGroup>
        ) : null}

        {currentTaskRows.length > 0 ? (
          <CommandGroup heading="Current task">
            {currentTaskRows.map((row) => (
              <Row key={row.value} {...row} />
            ))}
          </CommandGroup>
        ) : null}

        {actionRows.length > 0 ? (
          <CommandGroup heading="Actions">
            {actionRows.map((row) => (
              <Row key={row.value} {...row} />
            ))}
          </CommandGroup>
        ) : null}

        {activeProviders.map((id) => (
          <ProviderGroup
            key={id}
            id={id}
            provider={SEARCH_PROVIDERS[id]}
            query={debounced}
            scoped={!isAll}
            onOpen={(target) => openTarget(target, false)}
            onLoading={onProviderLoading}
          />
        ))}

        <EmptyState
          visible={!hasClientRows && loadingProviders.size === 0 && query === debounced}
          query={query}
          scopeLabel={scopeLabel}
        />
      </CommandList>
      <div className="flex items-center gap-3 border-t border-border-subtle px-3 py-2 text-[11px] text-muted-foreground max-sm:hidden">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="flex items-center gap-1">
          <Kbd>
            <CornerDownLeft className="size-2.5" />
          </Kbd>{" "}
          open
        </span>
        <span className="flex items-center gap-1">
          <Kbd>{modKeyLabel()}</Kbd>
          <Kbd>
            <CornerDownLeft className="size-2.5" />
          </Kbd>{" "}
          new tab
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Tab</Kbd> filter
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Kbd>Esc</Kbd> close
        </span>
      </div>
    </div>
  );
}

/**
 * Shown when no group has rows. cmdk's `CommandEmpty` counts items, and an
 * async group with no rows yet would hide it, so the palette decides itself.
 */
function EmptyState({
  visible,
  query,
  scopeLabel,
}: {
  visible: boolean;
  query: string;
  scopeLabel: string;
}) {
  // Provider groups are items too: no rows at all means nothing matched.
  const count = useCommandState((state) => state.filtered.count);
  if (!visible || count > 0) return null;
  return (
    <div className="flex flex-col items-center gap-1 py-8 text-center text-sm text-muted-foreground">
      <Search className="size-4" />
      {query ? (
        <span>No results for “{query}”</span>
      ) : (
        <span>Type to search {scopeLabel === "All" ? "everything" : scopeLabel.toLowerCase()}</span>
      )}
    </div>
  );
}
