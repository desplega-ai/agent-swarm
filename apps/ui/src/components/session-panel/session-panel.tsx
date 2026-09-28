/**
 * <SessionPanel> — start or continue a swarm session about "the thing on
 * screen" without leaving it. Reusable: everything host-specific comes in
 * through props (API client, user, page key, labels, navigation), and it only
 * imports UI primitives, so the dashboard mounts it through a thin adapter and
 * a swarm App can mount it the same way.
 *
 * - A dropdown lists the user's earlier sessions under `pageKey` plus "New
 *   session"; the last choice is remembered per page key.
 * - "New session" creates a root task with a fresh per-session context key
 *   and `contextFooter` appended; the new session is selected in place.
 * - Follow-ups steer a running lead leaf, otherwise create a child task that
 *   inherits the context key server-side.
 * - Session list and detail poll on their own (no host QueryClient needed).
 */

import { ArrowUp, ExternalLink, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { SessionPanelClient } from "./http-client";
import {
  contextKeyPrefix,
  followUpTarget,
  LIST_POLL_MS,
  newSessionContextKey,
  type SessionPanelDetail,
  type SessionPanelListItem,
  type SessionPanelTask,
  sessionLabel,
  sessionPollMs,
  statusLabel,
  TERMINAL_STATUSES,
  timelineEntries,
  withContextFooter,
} from "./model";
import { usePolled } from "./use-polled";

export const NEW_SESSION = "__new__";

type SelectionStorage = Pick<Storage, "getItem" | "setItem">;

export interface SessionPanelProps {
  client: SessionPanelClient;
  /** Stable key for the thing on screen, e.g. `task:ui:workflow:<id>`. No trailing `:`. */
  pageKey: string;
  /** One-line description of the context, shown in the header. */
  contextLabel: string;
  /** Appended to the first message of a new session (see `buildContextFooter`). */
  contextFooter?: string;
  /** Sent as `requestedByUserId`; the list shows only this user's sessions. `null` disables sending. */
  userId: string | null;
  /** Steer a running lead task instead of queueing a child. Default `true`. */
  steeringSupported?: boolean;
  /** Where the last selection per page is remembered. Default `localStorage`; `null` disables it. */
  storage?: SelectionStorage | null;
  /** Namespace for storage keys, e.g. the API URL, so two deployments do not collide. */
  storageNamespace?: string;
  /** Renders an "open full view" button when set. */
  onOpenSession?: (rootTaskId: string) => void;
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
  client,
  pageKey,
  contextLabel,
  contextFooter,
  userId,
  steeringSupported = true,
  storage,
  storageNamespace,
  onOpenSession,
  onClose,
  title = "Session about this page",
  className,
}: SessionPanelProps) {
  const store = storage === undefined ? defaultStorage() : storage;
  const storageKey = `session-panel:last:${storageNamespace ? `${storageNamespace}:` : ""}${pageKey}`;
  const [selected, setSelected] = useLastSelection(store, storageKey);
  const [newContextKey, setNewContextKey] = useState(() => newSessionContextKey(pageKey));

  const loadList = useMemo(
    () =>
      userId
        ? () =>
            client.listSessions({
              contextKeyPrefix: contextKeyPrefix(pageKey),
              requestedByUserId: userId,
              limit: 20,
            })
        : null,
    [client, pageKey, userId],
  );
  const list = usePolled<SessionPanelListItem[]>(loadList, () => LIST_POLL_MS);
  const items = list.data ?? [];

  const isNew = selected === NEW_SESSION;
  // A session created a moment ago can lag the list; keep it selectable.
  const selectedInList = isNew || items.some((s) => s.root.id === selected);

  const onSelect = (value: string) => {
    if (value === NEW_SESSION) setNewContextKey(newSessionContextKey(pageKey));
    setSelected(value);
  };

  const onCreated = (rootTaskId: string) => {
    setSelected(rootTaskId);
    list.refresh();
  };

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
      data-testid="session-panel"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
          <p className="truncate text-xs font-medium text-foreground" title={contextLabel}>
            {contextLabel}
          </p>
        </div>
        {!isNew && onOpenSession ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => onOpenSession(selected)}
            aria-label="Open full view"
            title="Open full view"
          >
            <ExternalLink className="size-4" />
          </Button>
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
        <Select value={selectedInList ? selected : ""} onValueChange={onSelect}>
          <SelectTrigger className="h-9 w-full text-xs" aria-label="Sessions for this page">
            <SelectValue placeholder={list.loading ? "Loading sessions…" : "Session"} />
          </SelectTrigger>
          <SelectContent className="max-h-[60vh]">
            <SelectItem value={NEW_SESSION} className="text-xs">
              New session
            </SelectItem>
            {items.map((s) => (
              <SelectItem key={s.root.id} value={s.root.id} className="text-xs">
                <span className="block max-w-[300px] truncate">
                  {sessionLabel(s.root)}
                  <span className="text-muted-foreground">
                    {" · "}
                    {relativeTime(s.lastActivityAt)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isNew ? (
        <NewSession
          key={newContextKey}
          client={client}
          contextKey={newContextKey}
          contextFooter={contextFooter}
          userId={userId}
          onCreated={onCreated}
        />
      ) : (
        <ActiveSession
          key={selected}
          client={client}
          rootTaskId={selected}
          userId={userId}
          steeringSupported={steeringSupported}
        />
      )}
    </div>
  );
}

function NewSession({
  client,
  contextKey,
  contextFooter,
  userId,
  onCreated,
}: {
  client: SessionPanelClient;
  contextKey: string;
  contextFooter?: string;
  userId: string | null;
  onCreated: (rootTaskId: string) => void;
}) {
  const send = useCallback(
    async (text: string) => {
      const created = await client.createSession({
        task: withContextFooter(text, contextFooter),
        contextKey,
        requestedByUserId: userId ?? undefined,
      });
      onCreated(created.id);
    },
    [client, contextFooter, contextKey, userId, onCreated],
  );
  return (
    <>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6">
        <p className="max-w-xs text-center text-sm text-muted-foreground">
          Ask about this page or leave feedback. The lead picks it up with this page's context
          attached.
        </p>
      </div>
      <Composer
        onSend={send}
        disabled={!userId}
        placeholder={userId ? "Message the swarm…" : "Pick an identity to send messages."}
      />
    </>
  );
}

function ActiveSession({
  client,
  rootTaskId,
  userId,
  steeringSupported,
}: {
  client: SessionPanelClient;
  rootTaskId: string;
  userId: string | null;
  steeringSupported: boolean;
}) {
  const load = useMemo(() => () => client.getSession(rootTaskId), [client, rootTaskId]);
  const session = usePolled<SessionPanelDetail>(load, sessionPollMs);
  const detail = session.data;
  const entries = useMemo(() => (detail ? timelineEntries(detail) : []), [detail]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastEntryKey = entries.at(-1)?.key;
  const lastEntryUpdate = entries.at(-1)?.kind === "agent" ? entries.at(-1) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the tail changes
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastEntryKey, lastEntryUpdate]);

  const send = useCallback(
    async (text: string) => {
      if (!detail) return;
      const target = followUpTarget(detail, steeringSupported);
      const requestedByUserId = userId ?? undefined;
      if (target.kind === "steer") {
        await client.steer(target.taskId, { message: text, requestedByUserId });
      } else {
        await client.createFollowUp({
          task: text,
          parentTaskId: target.parentTaskId,
          requestedByUserId,
        });
      }
      session.refresh();
    },
    [client, detail, steeringSupported, userId, session.refresh],
  );

  return (
    <>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-4">
        {detail ? (
          <ol className="flex flex-col gap-3" aria-label="Session messages">
            {entries.map((entry) =>
              entry.kind === "user" ? (
                <li key={entry.key} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground">
                    {entry.text}
                  </div>
                </li>
              ) : (
                <li key={entry.key}>
                  <AgentRow task={entry.task} delegated={entry.delegated} />
                </li>
              ),
            )}
          </ol>
        ) : session.error ? (
          <p className="text-xs text-muted-foreground">
            Couldn't load this session. It may have been deleted, or the API server is offline.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
      </div>
      <Composer
        onSend={send}
        disabled={!userId || !detail}
        placeholder={userId ? "Continue the session…" : "Pick an identity to send messages."}
      />
    </>
  );
}

function AgentRow({ task, delegated }: { task: SessionPanelTask; delegated: boolean }) {
  const done = TERMINAL_STATUSES.has(task.status);
  const who = task.agentName ?? (task.isLeadTask ? "Lead" : "Agent");
  const body =
    task.status === "completed"
      ? task.output
      : task.status === "failed"
        ? task.failureReason
        : done
          ? null
          : task.progress;

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2" data-status={task.status}>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {!done ? <Spinner className="size-3" /> : null}
        <span className="font-medium text-foreground">{who}</span>
        <span>· {statusLabel(task.status)}</span>
      </div>
      {delegated ? (
        <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
          {firstLine(task.task)}
        </p>
      ) : null}
      {body ? (
        delegated || !done ? (
          <p
            className={cn(
              "mt-1 whitespace-pre-wrap break-words text-xs",
              done ? "text-foreground" : "text-muted-foreground",
              delegated && "line-clamp-4",
            )}
          >
            {body}
          </p>
        ) : (
          <div className="prose-chat mt-1 min-w-0 break-words text-xs leading-relaxed text-foreground/85 [&_pre]:max-w-full [&_pre]:overflow-x-auto">
            <Streamdown>{body}</Streamdown>
          </div>
        )
      ) : null}
    </div>
  );
}

function Composer({
  onSend,
  disabled,
  placeholder,
}: {
  onSend: (text: string) => Promise<void>;
  disabled: boolean;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const text = draft.trim();
    if (!text || pending || disabled) return;
    setPending(true);
    setError(null);
    try {
      await onSend(text);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setPending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="border-t border-border p-3">
      {error ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}
      <div className="flex items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled || pending}
          rows={2}
          className="max-h-40 min-h-[44px] resize-none text-xs"
          aria-label="Message"
        />
        <Button
          type="button"
          size="icon"
          className="size-9 shrink-0"
          onClick={() => void submit()}
          disabled={disabled || pending || draft.trim().length === 0}
          aria-label="Send"
        >
          {pending ? <Spinner className="size-4" /> : <ArrowUp className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? ""
  );
}

function relativeTime(iso: string): string {
  // The API emits SQLite UTC timestamps without a zone suffix.
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(" ", "T")}Z`;
  const diff = Date.now() - new Date(normalized).getTime();
  if (!Number.isFinite(diff)) return "";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
