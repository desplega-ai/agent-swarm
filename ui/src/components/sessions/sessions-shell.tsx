/**
 * Sessions surface — shared shell composing the sidebar (search + filters
 * dropdown + new + collapse + list) with a right pane. Both `/sessions` and
 * `/sessions/:rootTaskId` mount this so they share visuals.
 *
 * Filtering and search are pushed up to the API: the shell owns the
 * URL-backed `q` and `system` state and passes them as `q` and `source` to
 * `useSessions`. Search is debounced (~200ms) so each keystroke doesn't
 * fire a request.
 *
 * Desktop (≥lg): 300px sidebar + 1fr right pane. The sidebar can be
 * collapsed (state in localStorage).
 * Mobile  (<lg): the sidebar list collapses into a Select dropdown above
 * the right pane; the new-session button sits next to it.
 */

import { ChevronLeft, Filter, MessageSquare, PanelLeftOpen, Plus, Search } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSessions } from "@/api/hooks/use-sessions";
import type { SessionListItem } from "@/api/types";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { cn, formatRelativeTime } from "@/lib/utils";

const COLLAPSE_STORAGE_KEY = "agent-swarm-sessions-sidebar-collapsed";
const SHOW_SYSTEM_STORAGE_KEY = "agent-swarm-sessions-show-system";

/**
 * Sources that count as human-initiated chat sessions. Anything else
 * (boot-triage, heartbeat, scheduled jobs, slack threads, etc.) is hidden
 * from the sidebar by default and only revealed via the filters dropdown.
 */
const SESSION_SOURCES = ["ui"] as const;
const RUNNING_STATUSES = new Set<string>(["in_progress", "pending", "offered", "backlog"]);

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v === "1") return true;
    if (v === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* best-effort */
  }
}

interface SessionRowProps {
  session: SessionListItem;
  isActive: boolean;
}

function SessionRow({ session: s, isActive }: SessionRowProps) {
  const isRunning = RUNNING_STATUSES.has(s.latestStatus);
  const isFailed = s.latestStatus === "failed" || s.latestStatus === "cancelled";
  return (
    <Link
      to={`/sessions/${s.root.id}`}
      className={cn(
        "group relative flex items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors min-w-0",
        "hover:bg-muted/50",
        isActive && "bg-muted",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 transition-colors",
          isRunning
            ? "bg-primary animate-pulse"
            : isFailed
              ? "bg-status-error"
              : isActive
                ? "bg-primary/70"
                : "bg-muted-foreground/30 group-hover:bg-muted-foreground/60",
        )}
      />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span
          className={cn(
            "text-sm leading-snug truncate",
            isActive ? "font-medium text-foreground" : "text-foreground/90",
          )}
        >
          {s.root.task}
        </span>
        <span className="text-[11px] text-muted-foreground truncate">
          {formatRelativeTime(s.lastActivityAt)} · {s.chainTaskCount}{" "}
          {s.chainTaskCount === 1 ? "task" : "tasks"}
        </span>
      </div>
    </Link>
  );
}

interface SessionsListProps {
  sessions: SessionListItem[] | undefined;
  isLoading: boolean;
  activeRootTaskId?: string;
  query: string;
  onQueryChange: (q: string) => void;
  showSystem: boolean;
  onShowSystemChange: (value: boolean) => void;
  onCollapse?: () => void;
  onNewSession: () => void;
  identityState: "pending" | "needs-pick" | "ready";
}

function SessionsList({
  sessions,
  isLoading,
  activeRootTaskId,
  query,
  onQueryChange,
  showSystem,
  onShowSystemChange,
  onCollapse,
  onNewSession,
  identityState,
}: SessionsListProps) {
  const items = sessions ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1.5 shrink-0">
        <h2 className="text-[11px] font-mono uppercase tracking-[0.12em] text-muted-foreground">
          Sessions
        </h2>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                onClick={onNewSession}
                className="h-6 w-6"
                aria-label="New session"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New session</TooltipContent>
          </Tooltip>
          {onCollapse ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={onCollapse}
                  className="h-6 w-6"
                  aria-label="Collapse sessions list"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Collapse list</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-1 px-3 pb-2 shrink-0">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search"
            className="h-8 pl-7 text-xs bg-muted/40 border-transparent focus-visible:bg-card focus-visible:border-border"
            aria-label="Search sessions by initial task title"
          />
        </div>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className={cn("h-8 w-8 shrink-0 relative", showSystem && "text-primary")}
                  aria-label="Session filters"
                >
                  <Filter className="h-3.5 w-3.5" />
                  {showSystem ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary"
                    />
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Filters</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
              Filters
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={showSystem}
              onCheckedChange={(v) => onShowSystemChange(Boolean(v))}
            >
              Show system tasks
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {identityState === "needs-pick" ? (
          <div className="px-3">
            <EmptyState
              icon={MessageSquare}
              title="Identify yourself"
              description="Select your identity to see your sessions."
            />
          </div>
        ) : isLoading ? (
          <div className="flex flex-col gap-2 px-3">
            {Array.from({ length: 6 }).map((_, idx) => (
              <Skeleton key={`skeleton-${idx}`} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          query.trim().length > 0 ? (
            <div className="px-3 py-6 text-xs text-muted-foreground text-center">
              No sessions match "{query}".
            </div>
          ) : (
            <div className="px-3">
              <EmptyState
                icon={MessageSquare}
                title="No sessions yet"
                description="Start one with the + button above, or via the API / MCP / Slack."
              />
            </div>
          )
        ) : (
          <ul className="flex flex-col gap-0.5 px-2 pb-3">
            {items.map((s) => (
              <li key={s.root.id} className="min-w-0">
                <SessionRow session={s} isActive={activeRootTaskId === s.root.id} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface MobileSessionPickerProps {
  sessions: SessionListItem[] | undefined;
  isLoading: boolean;
  activeRootTaskId?: string;
  onNewSession: () => void;
}

function MobileSessionPicker({
  sessions,
  isLoading,
  activeRootTaskId,
  onNewSession,
}: MobileSessionPickerProps) {
  const navigate = useNavigate();
  const items = sessions ?? [];

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2 lg:hidden">
      <Select
        value={activeRootTaskId ?? ""}
        onValueChange={(value) => {
          if (value) navigate(`/sessions/${value}`);
        }}
        disabled={isLoading || items.length === 0}
      >
        <SelectTrigger className="flex-1 h-9 text-xs">
          <SelectValue placeholder={isLoading ? "Loading sessions…" : "Pick a session"} />
        </SelectTrigger>
        <SelectContent className="max-h-[60vh]">
          {items.map((s) => (
            <SelectItem key={s.root.id} value={s.root.id} className="text-xs">
              <span className="block max-w-[260px] truncate">{s.root.task}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" onClick={onNewSession} className="h-9 px-2.5">
        <Plus className="h-3.5 w-3.5" />
        New
      </Button>
    </div>
  );
}

interface SessionsShellApi {
  openNew: () => void;
}

const SessionsShellContext = createContext<SessionsShellApi | null>(null);

export function useSessionsShell(): SessionsShellApi {
  const ctx = useContext(SessionsShellContext);
  if (!ctx) {
    return { openNew: () => {} };
  }
  return ctx;
}

export interface SessionsShellProps {
  activeRootTaskId?: string;
  children: ReactNode;
}

export function SessionsShell({ activeRootTaskId, children }: SessionsShellProps) {
  const navigate = useNavigate();
  const { userId, state: identityState } = useCurrentUser();
  const { searchParams, setParam } = useUrlSearchState();
  const railParam = readStringParam(searchParams, "rail");
  const collapsed =
    railParam === "expanded"
      ? false
      : railParam === "collapsed"
        ? true
        : readBool(COLLAPSE_STORAGE_KEY, false);
  const systemParam = searchParams.get("system");
  const showSystem =
    systemParam == null ? readBool(SHOW_SYSTEM_STORAGE_KEY, false) : systemParam === "true";
  const query = readStringParam(searchParams, "q");
  const debouncedQuery = useDebouncedValue(query, 200);
  const setCollapsed = useCallback(
    (value: boolean) => setParam("rail", value ? "collapsed" : "expanded"),
    [setParam],
  );
  const setShowSystem = useCallback(
    (value: boolean) => setParam("system", value ? "true" : "false"),
    [setParam],
  );
  const setQuery = useCallback((value: string) => setParam("q", value), [setParam]);

  useEffect(() => {
    writeBool(COLLAPSE_STORAGE_KEY, collapsed);
  }, [collapsed]);

  useEffect(() => {
    writeBool(SHOW_SYSTEM_STORAGE_KEY, showSystem);
  }, [showSystem]);

  const sourceFilter = useMemo<string[] | undefined>(
    () => (showSystem ? undefined : [...SESSION_SOURCES]),
    [showSystem],
  );

  const { data: sessions, isLoading } = useSessions({
    limit: 50,
    source: sourceFilter,
    q: debouncedQuery.trim() || undefined,
    requestedByUserId: userId ?? undefined,
    enabled: identityState === "ready",
  });

  const openNew = useCallback(() => navigate("/sessions"), [navigate]);
  const api = useMemo<SessionsShellApi>(() => ({ openNew }), [openNew]);

  return (
    <SessionsShellContext.Provider value={api}>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <MobileSessionPicker
          sessions={sessions}
          isLoading={isLoading}
          activeRootTaskId={activeRootTaskId}
          onNewSession={openNew}
        />

        <div
          className={cn(
            "flex-1 min-h-0 grid grid-cols-1 gap-0 overflow-hidden",
            !collapsed && "lg:grid-cols-[300px_1fr]",
          )}
        >
          {!collapsed ? (
            <aside className="hidden lg:flex border-r border-border min-h-0 bg-card/40 flex-col">
              <SessionsList
                sessions={sessions}
                isLoading={isLoading}
                activeRootTaskId={activeRootTaskId}
                query={query}
                onQueryChange={setQuery}
                showSystem={showSystem}
                onShowSystemChange={setShowSystem}
                onCollapse={() => setCollapsed(true)}
                onNewSession={openNew}
                identityState={identityState}
              />
            </aside>
          ) : null}

          <section
            className={cn("flex flex-col min-h-0 min-w-0 relative", collapsed && "lg:pl-12")}
          >
            {collapsed ? (
              <div className="hidden lg:flex absolute top-3 left-3 z-10">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setCollapsed(false)}
                      className="h-7 w-7"
                      aria-label="Show sessions list"
                    >
                      <PanelLeftOpen className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Show sessions list</TooltipContent>
                </Tooltip>
              </div>
            ) : null}
            {children}
          </section>
        </div>
      </div>
    </SessionsShellContext.Provider>
  );
}
