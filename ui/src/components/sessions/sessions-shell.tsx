/**
 * Sessions surface (Phase 4 ≥1.76.0) — shared shell composing the sidebar +
 * search + new-session + collapse + mobile-select primitives. Both
 * `/sessions` and `/sessions/:rootTaskId` mount this so they share visuals.
 *
 * Desktop (≥lg): split view. Left = sidebar with search + new + list, with a
 * collapse toggle that hides the entire pane (state in localStorage).
 * Mobile  (<lg): the sidebar list collapses into a Select dropdown above the
 * right pane; the new-session button sits next to it.
 */

import {
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  PanelLeftOpen,
  Plus,
  Search,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { SessionListItem } from "@/api/types";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatRelativeTime } from "@/lib/utils";
import { NewSessionDialog } from "./new-session-dialog";

const COLLAPSE_STORAGE_KEY = "agent-swarm-sessions-sidebar-collapsed";

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* best-effort */
  }
}

function filterSessions(sessions: SessionListItem[] | undefined, query: string): SessionListItem[] {
  if (!sessions || sessions.length === 0) return [];
  const q = query.trim().toLowerCase();
  if (q.length === 0) return sessions;
  return sessions.filter((s) => s.root.task.toLowerCase().includes(q));
}

interface SessionRowProps {
  session: SessionListItem;
  isActive: boolean;
}

function SessionRow({ session: s, isActive }: SessionRowProps) {
  return (
    <Link
      to={`/sessions/${s.root.id}`}
      className={cn(
        "flex flex-col gap-1 rounded-md border border-transparent p-2.5 text-left transition-colors min-w-0",
        "hover:bg-muted/50",
        isActive && "border-border bg-muted",
      )}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <span className="text-sm font-medium truncate min-w-0">{s.root.task}</span>
        <Badge variant="outline" size="tag" className="shrink-0">
          {s.chainTaskCount}
        </Badge>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground min-w-0">
        <span className="truncate">{formatRelativeTime(s.lastActivityAt)}</span>
        <span className="font-mono uppercase tracking-wider text-[9px] shrink-0">
          {s.latestStatus.replace(/_/g, " ")}
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
  onCollapse?: () => void;
  onNewSession: () => void;
}

function SessionsList({
  sessions,
  isLoading,
  activeRootTaskId,
  query,
  onQueryChange,
  onCollapse,
  onNewSession,
}: SessionsListProps) {
  const filtered = useMemo(() => filterSessions(sessions, query), [sessions, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5 shrink-0">
        <h2 className="text-sm font-semibold">Sessions</h2>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onNewSession} className="h-7 px-2 text-xs">
            <Plus className="h-3.5 w-3.5" />
            New
          </Button>
          {onCollapse ? (
            <Button
              size="icon"
              variant="ghost"
              onClick={onCollapse}
              className="h-7 w-7"
              title="Collapse sessions list"
              aria-label="Collapse sessions list"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </header>

      <div className="border-b border-border px-3 py-2 shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search sessions"
            className="h-8 pl-7 text-xs"
            aria-label="Search sessions by initial task title"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: 6 }).map((_, idx) => (
              <Skeleton key={`skeleton-${idx}`} className="h-16 w-full" />
            ))}
          </div>
        ) : !sessions || sessions.length === 0 ? (
          <div className="p-3">
            <EmptyState
              icon={MessageSquare}
              title="No sessions yet"
              description="Start one with the New button above, or via the API / MCP / Slack."
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground text-center">
            No sessions match “{query}”.
          </div>
        ) : (
          <ul className="flex flex-col gap-1 p-2">
            {filtered.map((s) => (
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

/** Children inside <SessionsShell> can call useSessionsShell().openNew. */
export function useSessionsShell(): SessionsShellApi {
  const ctx = useContext(SessionsShellContext);
  if (!ctx) {
    return { openNew: () => {} };
  }
  return ctx;
}

export interface SessionsShellProps {
  sessions: SessionListItem[] | undefined;
  isLoading: boolean;
  activeRootTaskId?: string;
  children: ReactNode;
}

export function SessionsShell({
  sessions,
  isLoading,
  activeRootTaskId,
  children,
}: SessionsShellProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());
  const [query, setQuery] = useState("");
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);

  const api = useMemo<SessionsShellApi>(() => ({ openNew: () => setNewOpen(true) }), []);
  const openNew = api.openNew;

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
            "flex-1 min-h-0 grid grid-cols-1 gap-0 border border-border rounded-md overflow-hidden",
            !collapsed && "lg:grid-cols-[320px_1fr]",
          )}
        >
          {!collapsed ? (
            <aside className="hidden lg:flex border-r border-border min-h-0 bg-card flex-col">
              <SessionsList
                sessions={sessions}
                isLoading={isLoading}
                activeRootTaskId={activeRootTaskId}
                query={query}
                onQueryChange={setQuery}
                onCollapse={() => setCollapsed(true)}
                onNewSession={openNew}
              />
            </aside>
          ) : null}

          <section
            className={cn("flex flex-col min-h-0 min-w-0 relative", collapsed && "lg:pl-12")}
          >
            {collapsed ? (
              <div className="hidden lg:flex absolute top-2 left-2 z-10">
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => setCollapsed(false)}
                  className="h-7 w-7 bg-card"
                  title="Show sessions list"
                  aria-label="Show sessions list"
                >
                  <PanelLeftOpen className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : null}
            {children}
          </section>
        </div>
      </div>

      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} />
    </SessionsShellContext.Provider>
  );
}

/** Centered "pick a session" placeholder. Reads onNewSession from shell context. */
export function SessionsEmptyPane() {
  const { openNew } = useSessionsShell();
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-6">
      <EmptyState
        icon={ChevronRight}
        title="Pick a session"
        description="Select a session from the sidebar — or start a fresh one."
        action={
          <Button size="sm" onClick={openNew}>
            <Plus className="h-3.5 w-3.5" />
            New session
          </Button>
        }
      />
    </div>
  );
}
