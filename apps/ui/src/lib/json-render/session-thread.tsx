/**
 * `SessionThread` — bind an app page to a swarm task chain's history.
 *
 * Read side: binds to `rootTaskId` and fetches the whole `parentTaskId`-linked
 * chain via `useSession` (gated behind `useFeatureGate("1.76.0")` — see the
 * fallback branch for older servers), rendered as one row per chain entry
 * (request text + outcome/live-progress) — see `SessionThreadTurn` below. The
 * chain entry with the latest `createdAt` is the "leaf" task — the one a new
 * message steers or chains off of.
 *
 * Send side, routed by whether a root exists and the leaf task's status:
 *   - NO `rootTaskId` bound → dispatch the `onDispatch` action chain with
 *     `$form = { message }` and `$chain = { leafTaskId: null, newTaskId: null }`
 *     — explicit absence, so a `parentTaskId: { "$chain": "leafTaskId" }`
 *     param is dropped and the task starts as a root. On success, `onRootCreated` (when provided) runs
 *     immediately after with `$chain = { newTaskId }` so the app can
 *     `app.mutate` it back onto `rootTaskId`. This is the ONLY branch that
 *     fires `onRootCreated` — every other branch already has a root.
 *   - `rootTaskId` bound AND the leaf task is not finished → steer it via
 *     `POST /api/tasks/<id>/steer` (the existing `useSteerTask` hook), always
 *     `mode: "queue"` (app pages never advertise per-harness interrupt
 *     capability) and `source: "app-page"`. The server live-delivers only for
 *     `in_progress` and the pre-start statuses (`unassigned` / `offered` /
 *     `pending`); for everything else it can still reach (`backlog`,
 *     `reviewing`, `paused`) `requestSteering` (`src/be/steering.ts`)
 *     PROMOTES the message into a follow-up task — the `describeOutcome`
 *     toast surfaces that fork, because the thread keeps showing the chain as
 *     it stood before the promotion.
 *   - `rootTaskId` bound AND the leaf task is terminal (`completed` /
 *     `failed` / `cancelled` / `superseded` / `skipped` / `draft`) → dispatch the
 *     `onDispatch` chain again, this time with `$chain.leafTaskId` set to the
 *     current leaf's id so the chain can pass it through as `parentTaskId`
 *     and extend the chain instead of starting a disconnected task.
 *     `onRootCreated` does NOT fire here — the root already exists.
 *
 *   - `rootTaskId` bound but its loaded chain is empty (deleted, or not
 *     visible) → sending is blocked with a notice. `leafTaskId: null` is only
 *     ever published when there is no root.
 *
 * After a dispatch that created a task, the session query is invalidated and
 * sending stays blocked until the chain shows that task (or, on the first
 * send, the page binds it as `rootTaskId`), so a quick second message cannot
 * chain off the old leaf or start a second root.
 *
 * A static action chain cannot conditionally skip a step, so the
 * `onDispatch`/`onRootCreated` split exists specifically to keep the
 * first-ever dispatch (which must adopt its new task as the root) distinct
 * from every later dispatch (which must NOT re-run that adoption and
 * collapse the chain back to single-task behavior).
 *
 * An explicit `onReset` chain (rendered as a small control near the status
 * badge, only when provided and a root is bound) clears `rootTaskId` so the
 * next message deliberately starts a new chain.
 *
 * Agent-written content is bounded: the latest `SESSION_THREAD_MAX_TURNS`
 * turns render (older ones behind a notice), and each turn's request text and
 * output are capped (`turnRequestText` / `boundTurnTask`). The detail sheet
 * keeps the full task.
 *
 * The composer draft is mirrored to `/ui/<id>/value` (the same interactivity
 * root SearchInput/Select own), so it survives re-renders and other elements
 * can bind it.
 */

import { getByPath, type InferComponentProps } from "@json-render/core";
import { useActions, useStateStore } from "@json-render/react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Maximize2, RotateCcw, Send } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSession } from "@/api/hooks/use-sessions";
import { useSteerTask, useTask } from "@/api/hooks/use-tasks";
import type { AgentTask } from "@/api/types";
import { TaskDetailSheet } from "@/components/sessions/task-detail-sheet";
import { TaskOutcome } from "@/components/sessions/task-outcome";
import { StatusBadge } from "@/components/shared/status-badge";
import { summarizeAgentLog } from "@/components/shared/transcript/transcript-rows";
import { describeOutcome } from "@/components/steering/steer-composer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/contexts/current-user-context";
import { cn } from "@/lib/utils";
import type { ActionChain, swarmCatalog } from "./catalog";
import {
  boundTurnTask,
  isDispatchSettled,
  isScrolledToBottom,
  latestStepText,
  pendingTurnLabel,
  resolveLeafTask,
  resolveSessionThreadRoute,
  runDispatchChain,
  runResetChain,
  SESSION_THREAD_MAX_TURNS,
  turnRequestText,
  visibleTurns,
} from "./session-thread-model";

export type SessionThreadProps = InferComponentProps<typeof swarmCatalog, "SessionThread">;

const SESSIONS_MIN_VERSION = "1.76.0";

/** Poll interval for the live leaf turn's latest step (the task's activity log). */
const LIVE_STEP_POLL_MS = 5000;

/**
 * Longest wait for a sent task to show up in the chain before sending unlocks
 * anyway, so a page that never binds the new root cannot lock the composer.
 */
const PENDING_DISPATCH_TIMEOUT_MS = 30_000;

/** Stable empty chain, so the memos below hold while the session loads. */
const EMPTY_CHAIN: AgentTask[] = [];

/**
 * The status line of a turn with no outcome yet. Only an `in_progress` turn
 * spins; the live leaf turn also polls its task for the latest activity step
 * (`latestStepText`). Other turns show their label without fetching.
 */
function PendingTurnStatus({ task, live }: { task: AgentTask; live: boolean }) {
  const label = pendingTurnLabel(task.status) ?? "Working…";
  const working = task.status === "in_progress";
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground" aria-live="polite">
      <div className="flex items-center gap-2">
        {working ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" /> : null}
        <span className={cn("truncate", working && "shimmer-text")}>{label}</span>
      </div>
      {live && working ? <LiveStep taskId={task.id} /> : null}
    </div>
  );
}

function LiveStep({ taskId }: { taskId: string }) {
  const { data } = useTask(taskId, { refetchInterval: LIVE_STEP_POLL_MS });
  const step = data ? latestStepText(data.logs, summarizeAgentLog) : null;
  if (!step) return null;
  return (
    <span className="truncate pl-5" data-slot="session-thread-step">
      {step}
    </span>
  );
}

/**
 * One chain entry — the request text, then either a status line (no outcome
 * yet) or `TaskOutcome`, plus a click-through to the full transcript in both
 * cases. Each task IS the request+response pair (`extractRequestText` pulls
 * the user's message back out of `task.task`, which for an app-dispatched
 * task is the full agent prompt with the message in a trailing marker).
 */
function SessionThreadTurn({ task, live }: { task: AgentTask; live: boolean }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const pending = pendingTurnLabel(task.status) !== null;
  const boundedTask = useMemo(() => boundTurnTask(task), [task]);

  return (
    // `shrink-0`: in the fixed-height turn list a shrinking row squeezes its
    // clamped outcome, so `ShowMore` would measure an overflow that isn't there.
    <div
      data-slot="session-thread-turn"
      className="flex shrink-0 flex-col gap-1.5 border-b border-border-subtle pb-3 last:border-b-0 last:pb-0"
    >
      <p className="text-sm text-foreground whitespace-pre-wrap break-words min-w-0">
        {turnRequestText(task)}
      </p>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {pending ? (
            <PendingTurnStatus task={task} live={live} />
          ) : (
            <TaskOutcome task={boundedTask} clamp />
          )}
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => setDetailOpen(true)}
          className="h-6 w-6 shrink-0"
          aria-label="Open task details"
        >
          <Maximize2 className="h-3 w-3" />
        </Button>
      </div>
      <TaskDetailSheet
        taskId={task.id}
        task={task}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function SessionThreadComponent({ props }: { props: SessionThreadProps }) {
  const { state, set, getSnapshot } = useStateStore();
  const { execute } = useActions();
  const { userId } = useCurrentUser();
  const queryClient = useQueryClient();
  const steerTask = useSteerTask();
  const [dispatching, setDispatching] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);

  const draftPath = `/ui/${props.id}/value`;
  const stored = getByPath(state, draftPath);
  const draft = typeof stored === "string" ? stored : "";

  const gate = useFeatureGate(SESSIONS_MIN_VERSION);

  // An unresolved binding arrives as undefined/null; an empty string means the
  // row column exists but no chain was started yet — both land here as "no
  // root". Accepted window: while the row query backing a `{ "$state": … }`
  // rootTaskId binding is still in flight this also reads as "no root", so a
  // send inside that first poll could start a second chain.
  const rootTaskId =
    typeof props.rootTaskId === "string" && props.rootTaskId !== "" ? props.rootTaskId : "";

  const { data: detail, isError: chainLoadFailed } = useSession(
    gate.supported && rootTaskId ? rootTaskId : undefined,
  );
  const chain = detail?.chain ?? EMPTY_CHAIN;
  const { turns, hidden: hiddenTurns } = useMemo(() => visibleTurns(chain), [chain]);
  const leafTask = useMemo(() => resolveLeafTask(chain), [chain]);

  // While a bound root's chain is still loading (or failed to load), hold
  // off routing rather than guess.
  const chainLoaded = rootTaskId === "" || detail !== undefined;
  const { dispatchRoute, steerRoute, chainedDispatchRoute, chainMissing } =
    resolveSessionThreadRoute({ rootTaskId, chainLoaded, leafTask });

  // Like a chat: open at the newest turn and stay pinned to the bottom while
  // content settles (markdown, Show more toggles, a landing outcome all grow
  // the list after the first paint). Scrolling up unpins; scrolling back to
  // the bottom, or a new newest turn, pins again.
  const turnListRef = useRef<HTMLDivElement>(null);
  const turnContentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const newestTurn = turns.at(-1);
  const newestTurnKey = newestTurn ? `${newestTurn.id}:${newestTurn.status}` : "";
  useLayoutEffect(() => {
    if (!newestTurnKey) return;
    pinnedRef.current = true;
    const list = turnListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [newestTurnKey]);
  useEffect(() => {
    const list = turnListRef.current;
    const content = turnContentRef.current;
    if (!list || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const settled = isDispatchSettled({ pendingTaskId, rootTaskId, chain });
  useEffect(() => {
    if (pendingTaskId === null) return;
    if (settled) {
      setPendingTaskId(null);
      return;
    }
    const timer = setTimeout(() => setPendingTaskId(null), PENDING_DISPATCH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingTaskId, settled]);

  const onDispatchChain = props.onDispatch as ActionChain | undefined;
  const hasDispatchChain = Array.isArray(onDispatchChain) && onDispatchChain.length > 0;
  const onResetChain = props.onReset as ActionChain | undefined;
  const hasResetChain = Array.isArray(onResetChain) && onResetChain.length > 0;

  // Stable refs so async continuations (`dispatch`, `reset`) never run
  // against a stale chain / snapshot after a re-render.
  const propsRef = useRef(props);
  propsRef.current = props;
  const executeRef = useRef(execute);
  executeRef.current = execute;
  const getSnapshotRef = useRef(getSnapshot);
  getSnapshotRef.current = getSnapshot;

  /** Clear the draft only if it still holds the message that was sent. */
  const clearSentDraft = (message: string) => {
    const current = getByPath(getSnapshotRef.current(), draftPath);
    if (typeof current === "string" && current.trim() === message) set(draftPath, "");
  };

  const dispatch = async (
    message: string,
    routing: { wasEmpty: boolean; leafTaskId: string | null },
  ) => {
    const bindings = propsRef.current.onDispatch as ActionChain | undefined;
    if (!bindings || bindings.length === 0) return;
    const onRootCreated = propsRef.current.onRootCreated as ActionChain | undefined;
    setDispatching(true);
    try {
      const { newTaskId } = await runDispatchChain({
        onDispatch: bindings,
        onRootCreated,
        message,
        wasEmpty: routing.wasEmpty,
        leafTaskId: routing.leafTaskId,
        execute: executeRef.current,
        getSnapshot: getSnapshotRef.current,
      });
      // A first send without `onRootCreated` never binds a root, so there is
      // nothing to wait for: the next message starts another root anyway.
      const awaitsRoot = !routing.wasEmpty || (onRootCreated?.length ?? 0) > 0;
      if (newTaskId && awaitsRoot) setPendingTaskId(newTaskId);
      void queryClient.invalidateQueries({ queryKey: ["session"] });
      clearSentDraft(message);
    } catch (error) {
      setSendError(errorMessage(error, "Failed to send the message"));
    } finally {
      setDispatching(false);
    }
  };

  const reset = async () => {
    setSendError(null);
    try {
      await runResetChain({
        onReset: propsRef.current.onReset as ActionChain | undefined,
        execute: executeRef.current,
        getSnapshot: getSnapshotRef.current,
      });
    } catch (error) {
      setSendError(errorMessage(error, "Failed to reset the session"));
    }
  };

  const waitingForSend = !settled;
  const pending = steerTask.isPending || dispatching || waitingForSend;
  const canSend =
    draft.trim().length > 0 &&
    !pending &&
    (dispatchRoute ? hasDispatchChain : steerRoute || (chainedDispatchRoute && hasDispatchChain));

  const submit = () => {
    const message = draft.trim();
    if (message.length === 0 || !canSend) return;
    setSendError(null);
    steerTask.reset();
    if (steerRoute && leafTask) {
      steerTask.mutate(
        {
          id: leafTask.id,
          message,
          mode: "queue",
          requestedByUserId: userId ?? undefined,
          source: "app-page",
        },
        {
          // `describeOutcome` (shared with the dashboard's SteerComposer)
          // matters most for `outcome === "promoted"`: the server turned the
          // message into a follow-up task, and the toast confirms it before the
          // chain re-fetch shows the new leaf.
          onSuccess: (result) => {
            toast.success(describeOutcome(result));
            clearSentDraft(message);
          },
        },
      );
      return;
    }
    if (dispatchRoute) {
      void dispatch(message, { wasEmpty: true, leafTaskId: null });
    } else if (chainedDispatchRoute && leafTask) {
      void dispatch(message, { wasEmpty: false, leafTaskId: leafTask.id });
    }
  };

  const steerError =
    steerTask.isError && steerTask.error instanceof Error ? steerTask.error.message : null;
  const shownError = sendError ?? steerError;

  const helper = dispatchRoute
    ? hasDispatchChain
      ? "No task yet — your message starts one."
      : "No root bound and no onDispatch chain configured."
    : !chainLoaded
      ? chainLoadFailed
        ? "The session could not be loaded — sending is disabled."
        : "Loading session…"
      : chainMissing
        ? "Conversation not found — sending is disabled."
        : waitingForSend
          ? "Waiting for the new task to appear…"
          : steerRoute || hasDispatchChain
            ? undefined
            : "This session has finished.";

  const fill = props.fill === true;

  if (!gate.supported) {
    return (
      <Card className="min-w-0 py-4" data-testid="json-render-session-thread">
        <CardContent className="px-4">
          <p className="text-sm text-muted-foreground">
            This session history view requires API ≥ {gate.requiredVersion}
            {gate.currentVersion ? ` (this swarm is running v${gate.currentVersion})` : ""}.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card
      className={cn("min-w-0 gap-3 py-4", fill && "flex h-full min-h-0 flex-col")}
      data-testid="json-render-session-thread"
    >
      <CardContent
        className={cn("flex min-w-0 flex-col gap-2 px-4", fill && "min-h-0 flex-1 overflow-hidden")}
      >
        {leafTask || hasResetChain ? (
          <div className={cn("flex items-center gap-2", fill && "shrink-0")}>
            {leafTask ? <StatusBadge status={leafTask.status} /> : null}
            {hasResetChain && rootTaskId ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => void reset()}
                aria-label="Reset session"
                className="ml-auto h-6 gap-1 px-2 text-xs text-muted-foreground"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </Button>
            ) : null}
          </div>
        ) : null}
        <div
          ref={turnListRef}
          data-slot="session-thread-turns"
          onScroll={(event) => {
            pinnedRef.current = isScrolledToBottom(event.currentTarget);
          }}
          className={cn("min-h-0 overflow-y-auto px-1 py-1", fill ? "flex-1" : "h-[420px]")}
        >
          <div ref={turnContentRef} className="flex flex-col gap-3">
            {turns.length > 0 ? null : (
              <p className="py-1 text-sm text-muted-foreground">
                No session yet — send a message to get started.
              </p>
            )}
            {hiddenTurns > 0 ? (
              <p
                className="px-1 text-xs text-muted-foreground"
                data-slot="session-thread-truncated"
              >
                Showing the latest {SESSION_THREAD_MAX_TURNS.toLocaleString()} turns (
                {hiddenTurns.toLocaleString()} older hidden)
              </p>
            ) : null}
            {turns.map((task) => (
              <SessionThreadTurn key={task.id} task={task} live={task.id === leafTask?.id} />
            ))}
          </div>
        </div>
        <div className={cn("flex flex-col gap-1.5", fill && "shrink-0")}>
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              placeholder={props.placeholder ?? "Send a message…"}
              aria-label={props.placeholder ?? "Message"}
              rows={1}
              className="h-9 min-h-9 field-sizing-fixed flex-1 resize-none overflow-y-auto py-1.5 text-sm md:text-sm"
              onChange={(event) => set(draftPath, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <Button
              type="button"
              size="icon"
              disabled={!canSend}
              onClick={submit}
              aria-label="Send message"
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          {shownError ? (
            <p className="text-xs text-status-error-strong" role="alert">
              {shownError}
            </p>
          ) : helper ? (
            <p className="text-xs text-muted-foreground">{helper}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
