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
 *   - `rootTaskId` bound AND the leaf task is non-terminal → steer it via
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
 *     `failed` / `cancelled` / `superseded` / `draft`) → dispatch the
 *     `onDispatch` chain again, this time with `$chain.leafTaskId` set to the
 *     current leaf's id so the chain can pass it through as `parentTaskId`
 *     and extend the chain instead of starting a disconnected task.
 *     `onRootCreated` does NOT fire here — the root already exists.
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
import { Loader2, Maximize2, RotateCcw, Send } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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
  isActiveForDisplay,
  latestStepText,
  resolveLeafTask,
  resolveSessionThreadRoute,
  runDispatchChain,
  runResetChain,
  SESSION_THREAD_MAX_TURNS,
  turnRequestText,
  visibleTurns,
} from "./session-thread-logic";

export type SessionThreadProps = InferComponentProps<typeof swarmCatalog, "SessionThread">;

const SESSIONS_MIN_VERSION = "1.76.0";

/** Poll interval for the live turn's latest step (the task's activity log). */
const LIVE_STEP_POLL_MS = 5000;

/**
 * The live indicator of an active turn: "Working…" plus the latest step from
 * the task's activity log (`latestStepText`), polled while the turn is live.
 * Its own component so only active turns fetch the task's logs.
 */
function LiveTurnStatus({ taskId }: { taskId: string }) {
  const { data } = useTask(taskId, { refetchInterval: LIVE_STEP_POLL_MS });
  const step = data ? latestStepText(data.logs, summarizeAgentLog) : null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground" aria-live="polite">
      <div className="flex items-center gap-2">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
        <span className="shimmer-text truncate">Working…</span>
      </div>
      {step ? (
        <span className="truncate pl-5" data-slot="session-thread-step">
          {step}
        </span>
      ) : null}
    </div>
  );
}

/**
 * One chain entry — the request text, then either a live "Working…"
 * indicator (active) or `TaskOutcome` (terminal), plus a click-through to the
 * full transcript in both cases — a WIP turn's logs are just as inspectable
 * as a finished one's. Each task IS the request+response pair
 * (`extractRequestText` pulls the user's actual message back out of
 * `task.task` — for an app-dispatched task that field is the FULL agent
 * prompt with the message JSON-embedded in a trailing marker, not the
 * message itself; `task.output`/`task.status` is the result) — there's no
 * separate user-bubble/agent-row split like the dashboard's multi-agent
 * timeline.
 */
function SessionThreadTurn({ task }: { task: AgentTask }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const active = isActiveForDisplay(task.status);
  const boundedTask = useMemo(() => boundTurnTask(task), [task]);

  return (
    <div className="flex flex-col gap-1.5 border-b border-border-subtle pb-3 last:border-b-0 last:pb-0">
      <p className="text-sm text-foreground whitespace-pre-wrap break-words min-w-0">
        {turnRequestText(task)}
      </p>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {active ? <LiveTurnStatus taskId={task.id} /> : <TaskOutcome task={boundedTask} clamp />}
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

export function SessionThreadComponent({ props }: { props: SessionThreadProps }) {
  const { state, set, getSnapshot } = useStateStore();
  const { execute } = useActions();
  const { userId } = useCurrentUser();
  const steerTask = useSteerTask();
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const draftPath = `/ui/${props.id}/value`;
  const stored = getByPath(state, draftPath);
  const draft = typeof stored === "string" ? stored : "";

  const gate = useFeatureGate(SESSIONS_MIN_VERSION);

  // An unresolved binding arrives as undefined/null; an empty string means the
  // row column exists but no chain was started yet — both land here as "no
  // root". Same ACCEPTED PoC WINDOW caveat as before: while the row query
  // backing a `{ "$state": … }` rootTaskId binding is still in flight, this
  // resolves to "no root" too — a user who types and sends inside that first
  // poll window could start a duplicate chain even though the row already
  // holds one. Renderer surgery to distinguish "binding loading" from
  // "resolved to nothing" is deliberately out of scope here.
  const rootTaskId =
    typeof props.rootTaskId === "string" && props.rootTaskId !== "" ? props.rootTaskId : "";

  const { data: detail, isError: chainLoadFailed } = useSession(rootTaskId || undefined);
  const chain = detail?.chain ?? [];
  const { turns, hidden: hiddenTurns } = useMemo(() => visibleTurns(chain), [chain]);

  const leafTask = useMemo(() => resolveLeafTask(chain), [chain]);

  // While a bound root's chain is still loading (or failed to load), hold
  // off routing rather than guess.
  const chainLoaded = rootTaskId === "" || detail !== undefined;
  const { dispatchRoute, steerRoute, chainedDispatchRoute } = resolveSessionThreadRoute({
    rootTaskId,
    chainLoaded,
    leafTask,
  });

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

  const dispatch = async (message: string, routing: { wasEmpty: boolean; leafTaskId?: string }) => {
    const bindings = propsRef.current.onDispatch as ActionChain | undefined;
    if (!bindings || bindings.length === 0) return;
    setDispatching(true);
    setDispatchError(null);
    try {
      await runDispatchChain({
        onDispatch: bindings,
        onRootCreated: propsRef.current.onRootCreated as ActionChain | undefined,
        message,
        wasEmpty: routing.wasEmpty,
        leafTaskId: routing.leafTaskId ?? null,
        execute: executeRef.current,
        getSnapshot: getSnapshotRef.current,
      });
      set(draftPath, "");
    } catch (error) {
      setDispatchError(error instanceof Error ? error.message : "Failed to dispatch");
    } finally {
      setDispatching(false);
    }
  };

  const reset = async () => {
    await runResetChain({
      onReset: propsRef.current.onReset as ActionChain | undefined,
      execute: executeRef.current,
      getSnapshot: getSnapshotRef.current,
    });
  };

  const pending = steerTask.isPending || dispatching;
  const canSend =
    draft.trim().length > 0 &&
    !pending &&
    (dispatchRoute ? hasDispatchChain : chainLoaded && (steerRoute || hasDispatchChain));

  const submit = () => {
    const message = draft.trim();
    if (message.length === 0 || pending) return;
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
          // message into a follow-up task — the chain re-fetch (10s default
          // poll) will pick up the new leaf, but the toast confirms the fork
          // immediately instead of looking like the message vanished.
          onSuccess: (result) => {
            toast.success(describeOutcome(result));
            set(draftPath, "");
          },
        },
      );
      return;
    }
    if (hasDispatchChain && (dispatchRoute || chainedDispatchRoute)) {
      void dispatch(message, { wasEmpty: dispatchRoute, leafTaskId: leafTask?.id });
    }
  };

  const steerError =
    steerTask.isError && steerTask.error instanceof Error ? steerTask.error.message : null;
  const sendError = dispatchError ?? steerError;

  const helper = dispatchRoute
    ? hasDispatchChain
      ? "No task yet — your message starts one."
      : "No root bound and no onDispatch chain configured."
    : !chainLoaded
      ? chainLoadFailed
        ? "The session could not be loaded — sending is disabled."
        : "Loading session…"
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
        {turns.length > 0 ? (
          <div
            className={cn(
              "flex min-h-0 flex-col gap-3 overflow-y-auto px-1 py-1",
              fill ? "flex-1" : "h-[420px]",
            )}
          >
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
              <SessionThreadTurn key={task.id} task={task} />
            ))}
          </div>
        ) : (
          <p className="px-1 py-2 text-sm text-muted-foreground">
            No session yet — send a message to get started.
          </p>
        )}
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
          {sendError ? (
            <p className="text-xs text-status-error-strong">{sendError}</p>
          ) : helper ? (
            <p className="text-xs text-muted-foreground">{helper}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
