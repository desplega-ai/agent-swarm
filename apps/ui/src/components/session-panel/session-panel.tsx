/**
 * <SessionPanel> — start or continue a swarm session about "the thing on
 * screen" without leaving it. It is the Sessions page in a side panel: the
 * conversation, composer, meta caption, and new-session create path are the
 * same components `/sessions` renders (`components/sessions/*`). Host-specific
 * inputs (page key, context, labels, close) come in through props, so any
 * dashboard surface, including an app page, can mount it.
 *
 * - A picker lists the user's earlier sessions under `pageKey`, newest
 *   activity first, with server-side search, plus "New session"; the last
 *   choice is remembered per page key.
 * - "New session" creates a `source: "ui"` root task with a fresh per-session
 *   context key and `contextFooter` appended. The API assigns it to the Lead.
 *   The new session is selected in place.
 * - Links open the session in `/sessions` and its root task in `/tasks`; each
 *   task in the timeline opens its detail sheet, which links to its task page.
 */

import { ExternalLink, ListTree, X } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { useSession, useSessions } from "@/api/hooks/use-sessions";
import { ComposerDock } from "@/components/sessions/composer-dock";
import { SessionConversation } from "@/components/sessions/session-conversation";
import { SessionMeta } from "@/components/sessions/session-meta";
import { useStartSession } from "@/components/sessions/use-start-session";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { cn } from "@/lib/utils";
import { contextKeyPrefix, newSessionContextKey, sessionLabel, withContextFooter } from "./model";
import { NEW_SESSION, SessionPicker } from "./session-picker";

export { NEW_SESSION };

type SelectionStorage = Pick<Storage, "getItem" | "setItem">;

export interface SessionPanelProps {
  /** Stable key for the thing on screen, e.g. `task:ui:workflow:<id>`. No trailing `:`. */
  pageKey: string;
  /** One-line description of the context, shown in the header. */
  contextLabel: string;
  /** Appended to the first message of a new session (see `buildContextFooter`). */
  contextFooter?: string;
  /** Where the last selection per page is remembered. Default `localStorage`; `null` disables it. */
  storage?: SelectionStorage | null;
  /** Namespace for storage keys, e.g. the API URL, so two deployments do not collide. */
  storageNamespace?: string;
  /** Renders a close button when set. */
  onClose?: () => void;
  title?: string;
  className?: string;
}

export function SessionPanel(props: SessionPanelProps) {
  // Remount per page key so selection, drafts and the new-session key follow the page.
  return <SessionPanelBody key={props.pageKey} {...props} />;
}

function defaultStorage(): SelectionStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function useLastSelection(
  storage: SelectionStorage | null,
  storageKey: string,
): [string, (next: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      return storage?.getItem(storageKey) ?? NEW_SESSION;
    } catch {
      return NEW_SESSION;
    }
  });
  const set = useCallback(
    (next: string) => {
      try {
        storage?.setItem(storageKey, next);
      } catch {
        // Storage unavailable: the in-memory selection still works.
      }
      setValue(next);
    },
    [storage, storageKey],
  );
  return [value, set];
}

function SessionPanelBody({
  pageKey,
  contextLabel,
  contextFooter,
  storage,
  storageNamespace,
  onClose,
  title = "Session about this page",
  className,
}: SessionPanelProps) {
  const { userId } = useCurrentUser();
  const store = storage === undefined ? defaultStorage() : storage;
  const storageKey = `session-panel:last:${storageNamespace ? `${storageNamespace}:` : ""}${pageKey}`;
  const [selected, setSelected] = useLastSelection(store, storageKey);
  const [newContextKey, setNewContextKey] = useState(() => newSessionContextKey(pageKey));

  // Search and order are server-side, the same `q` the Sessions sidebar sends.
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 200);
  const list = useSessions({
    source: ["ui"],
    contextKeyPrefix: contextKeyPrefix(pageKey),
    q: debouncedQuery.trim() || undefined,
    requestedByUserId: userId ?? undefined,
    limit: 20,
    enabled: !!userId,
  });
  const items = userId ? (list.data ?? []) : [];

  const isNew = selected === NEW_SESSION;
  // The trigger label comes from the session itself: a search can filter it
  // out of the list, and one created a moment ago can lag the list.
  const { data: selectedDetail } = useSession(isNew ? undefined : selected);
  const selectedRoot = selectedDetail?.root;

  const onSelect = (value: string) => {
    if (value === NEW_SESSION) setNewContextKey(newSessionContextKey(pageKey));
    setSelected(value);
  };

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
      data-testid="session-panel"
    >
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
          <p className="truncate text-xs font-medium text-foreground" title={contextLabel}>
            {contextLabel}
          </p>
        </div>
        {!isNew ? (
          <>
            <HeaderLink to={`/tasks/${selected}`} label="Open root task">
              <ListTree className="size-4" />
            </HeaderLink>
            <HeaderLink to={`/sessions/${selected}`} label="Open in Sessions">
              <ExternalLink className="size-4" />
            </HeaderLink>
          </>
        ) : null}
        {onClose ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={onClose}
            aria-label="Close panel"
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>

      <div className="border-b border-border px-3 py-2">
        <SessionPicker
          selected={selected}
          selectedLabel={
            isNew ? "New session" : selectedRoot ? sessionLabel(selectedRoot) : "Session"
          }
          sessions={items}
          isLoading={list.isLoading}
          query={query}
          onQueryChange={setQuery}
          onSelect={onSelect}
        />
      </div>

      {isNew ? (
        <NewSession
          key={newContextKey}
          contextKey={newContextKey}
          contextFooter={contextFooter}
          onStarted={setSelected}
        />
      ) : (
        <ActiveSession key={selected} rootTaskId={selected} />
      )}
    </div>
  );
}

function HeaderLink({ to, label, children }: { to: string; label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon" className="size-8">
          <Link to={to} aria-label={label}>
            {children}
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function NewSession({
  contextKey,
  contextFooter,
  onStarted,
}: {
  contextKey: string;
  contextFooter?: string;
  onStarted: (rootTaskId: string) => void;
}) {
  const { userId, composerProps } = useStartSession({
    contextKey,
    buildTask: (typed) => withContextFooter(typed, contextFooter),
    onStarted: (created) => onStarted(created.id),
  });
  return (
    <>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6">
        <p className="max-w-xs text-center text-sm text-muted-foreground">
          Ask about this page or leave feedback. The lead picks it up with this page's context
          attached.
        </p>
      </div>
      <ComposerDock
        {...composerProps}
        placeholder={userId ? "Message the swarm…" : "Pick an identity to send messages."}
        sendLabel="Start session"
        autoFocus
      />
    </>
  );
}

function ActiveSession({ rootTaskId }: { rootTaskId: string }) {
  const { data: detail } = useSession(rootTaskId);
  return (
    <>
      {detail ? (
        <div className="border-b border-border px-3 py-2">
          <SessionMeta detail={detail} />
        </div>
      ) : null}
      <SessionConversation rootTaskId={rootTaskId} scrollClassName="px-3 py-4" />
    </>
  );
}
