/**
 * Contextual session panel — a docked right panel (full-screen sheet below
 * `lg`) that starts a swarm session about the current page without leaving it.
 *
 * - The header `Select` lists the viewer's earlier sessions for this page
 *   (`contextKeyPrefix = {pageKey}:`) plus "New session".
 * - "New session" embeds <NewSessionView> with a fresh per-session context key
 *   and the page-context footer; the created root is selected in place.
 * - A selected session renders the existing <SessionTimeline> and
 *   <SessionComposer>, so follow-ups keep the steer-or-child logic and inherit
 *   the context key server-side.
 * - The last selected session is remembered per page key.
 */

import { ChevronDown, ExternalLink, MessageSquarePlus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSession, useSessions } from "@/api/hooks/use-sessions";
import { useSteeringEnabled } from "@/api/hooks/use-stats";
import { NewSessionView } from "@/components/sessions/new-session-view";
import { SessionComposer } from "@/components/sessions/session-composer";
import { SessionTimeline } from "@/components/sessions/session-timeline";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { useConfig } from "@/hooks/use-config";
import { deriveStorageKey } from "@/hooks/use-dismissible-card-key";
import {
  buildContextFooter,
  getPageContext,
  newSessionContextKey,
  type PageContext,
  pageContextLabel,
} from "@/lib/page-context";
import { formatRelativeTime, sessionDisplayTitle } from "@/lib/utils";
import { useContextPanel } from "./context-panel-state";

const NEW_SESSION = "__new__";
const LG_QUERY = "(min-width: 1024px)";

function usePageContext(): PageContext | null {
  const { pathname, search, hash } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: search/hash feed window.location.href
  return useMemo(
    () => getPageContext({ pathname, url: window.location.href, title: document.title }),
    [pathname, search, hash],
  );
}

function useIsLg(): boolean {
  const [isLg, setIsLg] = useState(() => window.matchMedia(LG_QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(LG_QUERY);
    const onChange = () => setIsLg(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isLg;
}

/** Header button next to the notification bell. Hidden where the panel is not offered. */
export function ContextPanelToggle() {
  const { supported, open, toggle } = useContextPanel();
  const pageCtx = usePageContext();
  if (!supported || !pageCtx) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={open ? "secondary" : "ghost"}
          size="icon"
          className="size-8"
          onClick={toggle}
          aria-label="Session about this page"
          aria-pressed={open}
        >
          <MessageSquarePlus className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Session about this page (⌘I)</TooltipContent>
    </Tooltip>
  );
}

export function ContextSessionPanel() {
  const { open, setOpen } = useContextPanel();
  const pageCtx = usePageContext();
  const isLg = useIsLg();
  if (!open || !pageCtx) return null;

  // Remount per page so the selection and the new-session key follow the page.
  const body = <PanelBody key={pageCtx.pageKey} ctx={pageCtx} onClose={() => setOpen(false)} />;

  if (isLg) {
    return (
      <aside
        aria-label="Session about this page"
        className="flex h-svh w-[420px] shrink-0 flex-col border-l border-border bg-background"
      >
        {body}
      </aside>
    );
  }
  return (
    <Sheet open onOpenChange={setOpen}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-full">
        <SheetTitle className="sr-only">Session about this page</SheetTitle>
        <SheetDescription className="sr-only">
          Start or continue a swarm session with this page's context attached.
        </SheetDescription>
        {body}
      </SheetContent>
    </Sheet>
  );
}

function useLastSelection(pageKey: string): [string, (next: string) => void] {
  const { config } = useConfig();
  const storageKey = deriveStorageKey(config.apiUrl, `context-panel:last:${pageKey}`);
  const [value, setValue] = useState<string>(() => {
    try {
      return localStorage.getItem(storageKey) ?? NEW_SESSION;
    } catch {
      return NEW_SESSION;
    }
  });
  const set = useCallback(
    (next: string) => {
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        // Storage unavailable: the in-memory selection still works.
      }
      setValue(next);
    },
    [storageKey],
  );
  return [value, set];
}

function PanelBody({ ctx, onClose }: { ctx: PageContext; onClose: () => void }) {
  const { userId } = useCurrentUser();
  const [selected, setSelected] = useLastSelection(ctx.pageKey);
  const [newContextKey, setNewContextKey] = useState(() => newSessionContextKey(ctx.pageKey));
  const sessionsQ = useSessions({
    source: ["ui"],
    requestedByUserId: userId ?? undefined,
    contextKeyPrefix: `${ctx.pageKey}:`,
    limit: 20,
    enabled: !!userId,
  });
  const items = sessionsQ.data ?? [];
  const isNew = selected === NEW_SESSION;
  // A just-created session can lag the list refetch; keep it selectable meanwhile.
  const selectedInList = isNew || items.some((s) => s.root.id === selected);

  const onSelect = (value: string) => {
    if (value === NEW_SESSION) setNewContextKey(newSessionContextKey(ctx.pageKey));
    setSelected(value);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            This page
          </p>
          <p className="truncate text-xs font-medium text-foreground" title={ctx.url}>
            {pageContextLabel(ctx)}
          </p>
        </div>
        {!isNew ? (
          <Button asChild variant="ghost" size="icon" className="size-8">
            <Link to={`/sessions/${selected}`} aria-label="Open full view" title="Open full view">
              <ExternalLink className="size-4" />
            </Link>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onClose}
          aria-label="Close panel"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="border-b border-border px-3 py-2">
        <Select value={selectedInList ? selected : ""} onValueChange={onSelect}>
          <SelectTrigger className="h-9 w-full text-xs" aria-label="Sessions for this page">
            <SelectValue placeholder={sessionsQ.isLoading ? "Loading sessions…" : "Session"} />
          </SelectTrigger>
          <SelectContent className="max-h-[60vh]">
            <SelectItem value={NEW_SESSION} className="text-xs">
              New session
            </SelectItem>
            {items.map((s) => (
              <SelectItem key={s.root.id} value={s.root.id} className="text-xs">
                <span className="block max-w-[300px] truncate">
                  {sessionDisplayTitle(s.root)}
                  <span className="text-muted-foreground">
                    {" · "}
                    {formatRelativeTime(s.lastActivityAt)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {isNew ? (
          <NewSessionView
            key={newContextKey}
            contextKey={newContextKey}
            contextFooter={buildContextFooter(ctx)}
            onCreated={setSelected}
          />
        ) : (
          <PanelSession rootTaskId={selected} />
        )}
      </div>
    </div>
  );
}

function PanelSession({ rootTaskId }: { rootTaskId: string }) {
  // Steering (≥1.122.1): same gate as the session detail page.
  const steerGate = useFeatureGate("1.122.1");
  const { data: steeringEnabled = true } = useSteeringEnabled();
  const { data: detail, isLoading } = useSession(rootTaskId);

  const latestLeafTask = useMemo(() => {
    if (!detail || detail.chain.length === 0) return null;
    const sorted = [...detail.chain].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sorted[0] ?? detail.root;
  }, [detail]);

  const chainSignature = useMemo(
    () => detail?.chain.map((t) => `${t.id}:${t.status}:${t.lastUpdatedAt}`).join(",") ?? "",
    [detail?.chain],
  );
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { isFollowing, scrollToBottom } = useAutoScroll(scrollEl, [chainSignature]);

  return (
    <>
      <div className="relative min-h-0 flex-1">
        <div ref={setScrollEl} className="absolute inset-0 overflow-auto px-3 py-4">
          {isLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : detail ? (
            <SessionTimeline rootTaskId={rootTaskId} chain={detail.chain} />
          ) : (
            <p className="text-xs text-muted-foreground">
              Couldn't load this session. It may have been deleted, or the API server is offline.
            </p>
          )}
        </div>
        {!isFollowing ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={scrollToBottom}
            className="absolute bottom-0 left-1/2 z-10 h-8 -translate-x-1/2 translate-y-1/2 rounded-full bg-card px-3 shadow-sm"
            aria-label="Jump to latest"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            <span className="text-xs">Latest</span>
          </Button>
        ) : null}
      </div>
      <SessionComposer
        rootTaskId={rootTaskId}
        latestLeafTask={latestLeafTask}
        steeringSupported={steerGate.supported && steeringEnabled}
      />
    </>
  );
}
