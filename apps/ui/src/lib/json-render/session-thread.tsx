/**
 * `SessionThread` — bind an app page to a swarm task chain, rendered with the
 * same Sessions v2 pieces as the "Session about this page" side panel.
 *
 * - No `rootTaskId` bound: the panel's new-session look (a hint, then the
 *   shared `ComposerDock`). A send runs the `onDispatch` action chain with
 *   `$form = { message }` and `$chain = { leafTaskId: null, newTaskId: null }`
 *   — explicit absence, so a `parentTaskId: { "$chain": "leafTaskId" }` param
 *   is dropped and the task starts as a root. On success `onRootCreated` (when
 *   provided) runs with `$chain = { newTaskId }` so the app can `app.mutate`
 *   it back onto `rootTaskId`. This is the ONLY place `onRootCreated` fires.
 * - `rootTaskId` bound: the shared `SessionConversation` (turn timeline,
 *   "Latest" jump, `TaskComposer`), with the app keeping control of sends:
 *   - steer: the newest unfinished task of ANY agent (`steerTarget="any"`:
 *     app actions run on the action's agent, not necessarily the lead),
 *     attributed `source: "app-page"`. The shared `SteerComposer` offers the
 *     harness's Queue/Interrupt modes and reports a promoted steer.
 *   - follow up: `onFollowUp` runs the `onDispatch` chain again with
 *     `$chain.leafTaskId` = the composer's target (the newest task once all
 *     are finished), so the new task chains off the leaf. No task is created
 *     outside the page's own action; attachments and the mic are off.
 *   - a bound root whose chain is empty or not loaded rejects the follow-up
 *     (the draft stays), so a send never starts a disconnected root.
 *   - person bubbles show the `input.message` of each app action prompt
 *     (`threadRequestText`), not the whole agent prompt.
 *
 * After a dispatch that created a task, the send stays pending until the
 * chain shows that task (or, on the first send, the page binds it as
 * `rootTaskId`), up to `PENDING_DISPATCH_TIMEOUT_MS`, so a quick second
 * message cannot chain off the old leaf or start a second root.
 *
 * A static action chain cannot conditionally skip a step, so the
 * `onDispatch`/`onRootCreated` split keeps the first-ever dispatch (which must
 * adopt its new task as the root) distinct from every later one.
 *
 * `onReset` (a Reset control, only when provided and a root is bound) clears
 * `rootTaskId` so the next message deliberately starts a new chain.
 *
 * The composer draft is mirrored to `/ui/<id>/value`, so it survives
 * re-renders and other elements can bind it. Inside an element instance the
 * assembler namespaces `id`, so two instances keep separate drafts.
 */

import { getByPath, type InferComponentProps } from "@json-render/core";
import { useActions, useStateStore } from "@json-render/react";
import { useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSession } from "@/api/hooks/use-sessions";
import type { AgentTask } from "@/api/types";
import { ComposerDock } from "@/components/sessions/composer-dock";
import { SessionConversation } from "@/components/sessions/session-conversation";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/contexts/current-user-context";
import { cn } from "@/lib/utils";
import type { ActionChain, swarmCatalog } from "./catalog";
import {
  isDispatchSettled,
  runDispatchChain,
  runResetChain,
  threadRequestText,
} from "./session-thread-model";

export type SessionThreadProps = InferComponentProps<typeof swarmCatalog, "SessionThread">;

const SESSIONS_MIN_VERSION = "1.76.0";

/**
 * Longest wait for a sent task to show up in the chain before the send
 * settles anyway, so a page that never binds the new root cannot lock the
 * composer.
 */
const PENDING_DISPATCH_TIMEOUT_MS = 30_000;

/** The composer's routing hint: the page's action decides where a task goes. */
const ROUTE_LABEL = "Runs this page's action";

/** Stable empty chain while the session loads. */
const EMPTY_CHAIN: AgentTask[] = [];

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * `waitForTask(id)` resolves once the dispatched task `id` is in the chain or
 * bound as the root (`isDispatchSettled`), or after the timeout.
 */
function useWaitForTask(rootTaskId: string, chain: readonly AgentTask[]) {
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const resolveRef = useRef<(() => void) | null>(null);
  const settled = isDispatchSettled({ pendingTaskId, rootTaskId, chain });
  useEffect(() => {
    if (pendingTaskId === null) return;
    const finish = () => {
      setPendingTaskId(null);
      resolveRef.current?.();
      resolveRef.current = null;
    };
    if (settled) {
      finish();
      return;
    }
    const timer = setTimeout(finish, PENDING_DISPATCH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingTaskId, settled]);
  return (taskId: string) =>
    new Promise<void>((resolve) => {
      resolveRef.current?.();
      resolveRef.current = resolve;
      setPendingTaskId(taskId);
    });
}

export function SessionThreadComponent({ props }: { props: SessionThreadProps }) {
  const { state, set, getSnapshot } = useStateStore();
  const { execute } = useActions();
  const { userId } = useCurrentUser();
  const queryClient = useQueryClient();
  const gate = useFeatureGate(SESSIONS_MIN_VERSION);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const draftPath = `/ui/${props.id}/value`;
  const stored = getByPath(state, draftPath);
  const draft = typeof stored === "string" ? stored : "";
  const setDraft = (next: string) => set(draftPath, next);

  // An unresolved binding arrives as undefined/null; an empty string means the
  // row column exists but no chain was started yet — both read as "no root".
  // Accepted window: while the row query backing a `{ "$state": … }`
  // rootTaskId binding is still in flight this also reads as "no root", so a
  // send inside that first poll could start a second chain.
  const rootTaskId =
    typeof props.rootTaskId === "string" && props.rootTaskId !== "" ? props.rootTaskId : "";
  const { data: detail } = useSession(gate.supported && rootTaskId ? rootTaskId : undefined);
  const chain = detail?.chain ?? EMPTY_CHAIN;
  const waitForTask = useWaitForTask(rootTaskId, chain);

  // Stable refs so async continuations never run against a stale chain,
  // props or snapshot after a re-render.
  const propsRef = useRef(props);
  propsRef.current = props;
  const executeRef = useRef(execute);
  executeRef.current = execute;
  const getSnapshotRef = useRef(getSnapshot);
  getSnapshotRef.current = getSnapshot;
  const detailRef = useRef(detail);
  detailRef.current = detail;

  const onDispatchChain = props.onDispatch as ActionChain | undefined;
  const hasDispatchChain = Array.isArray(onDispatchChain) && onDispatchChain.length > 0;
  const onResetChain = props.onReset as ActionChain | undefined;
  const hasResetChain = Array.isArray(onResetChain) && onResetChain.length > 0;
  const placeholder = props.placeholder ?? "Send a message…";

  /**
   * Runs `onDispatch` (and, on a first send, `onRootCreated`). Returns the
   * new task's id when the send must wait for it to show up, else null.
   */
  const dispatch = async (message: string, leafTaskId: string | null) => {
    const onDispatch = propsRef.current.onDispatch as ActionChain | undefined;
    if (!onDispatch || onDispatch.length === 0) {
      throw new Error("This thread has no onDispatch action chain.");
    }
    const onRootCreated = propsRef.current.onRootCreated as ActionChain | undefined;
    const wasEmpty = leafTaskId === null;
    const { newTaskId } = await runDispatchChain({
      onDispatch,
      onRootCreated,
      message,
      wasEmpty,
      leafTaskId,
      execute: executeRef.current,
      getSnapshot: getSnapshotRef.current,
    });
    void queryClient.invalidateQueries({ queryKey: ["session"] });
    // A first send without `onRootCreated` never binds a root, so there is
    // nothing to wait for: the next message starts another root anyway.
    const awaitsTask = !wasEmpty || (onRootCreated?.length ?? 0) > 0;
    return newTaskId && awaitsTask ? newTaskId : null;
  };

  /** The first message: a new root task. */
  const start = async () => {
    const message = draft.trim();
    if (message.length === 0 || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const pendingTaskId = await dispatch(message, null);
      // Clear the draft only if it still holds the message that was sent.
      const current = getByPath(getSnapshotRef.current(), draftPath);
      if (typeof current === "string" && current.trim() === message) set(draftPath, "");
      if (pendingTaskId) await waitForTask(pendingTaskId);
    } catch (error) {
      setStartError(errorMessage(error, "Failed to send the message"));
    } finally {
      setStarting(false);
    }
  };

  /** `TaskComposer`'s follow-up: chain a new task off the leaf. */
  const followUp = async (message: string, parentTaskId: string | undefined) => {
    const loaded = detailRef.current;
    if (!loaded) throw new Error("The conversation is still loading.");
    if (loaded.chain.length === 0 || !parentTaskId) {
      throw new Error("Conversation not found — sending is disabled.");
    }
    const pendingTaskId = await dispatch(message, parentTaskId);
    if (pendingTaskId) await waitForTask(pendingTaskId);
  };

  const reset = async () => {
    setResetError(null);
    try {
      await runResetChain({
        onReset: propsRef.current.onReset as ActionChain | undefined,
        execute: executeRef.current,
        getSnapshot: getSnapshotRef.current,
      });
    } catch (error) {
      setResetError(errorMessage(error, "Failed to reset the session"));
    }
  };

  if (!gate.supported) {
    return (
      <div
        className="min-w-0 rounded-xl border border-border bg-card p-4"
        data-testid="json-render-session-thread"
      >
        <p className="text-sm text-muted-foreground">
          This session history view requires API ≥ {gate.requiredVersion}
          {gate.currentVersion ? ` (this swarm is running v${gate.currentVersion})` : ""}.
        </p>
      </div>
    );
  }

  return (
    // `SessionConversation` fills a flex column of definite height: the
    // parent's (`fill`) or a fixed one.
    <div
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background",
        props.fill === true ? "h-full min-h-0" : "h-[420px]",
      )}
      data-testid="json-render-session-thread"
    >
      {rootTaskId && hasResetChain ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
          {resetError ? (
            <p className="min-w-0 truncate text-xs text-status-error-strong" role="alert">
              {resetError}
            </p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void reset()}
            aria-label="Reset session"
            className="ml-auto h-6 gap-1 px-2 text-xs text-muted-foreground"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </Button>
        </div>
      ) : null}
      {rootTaskId ? (
        <SessionConversation
          rootTaskId={rootTaskId}
          timeline="turns"
          scrollClassName="px-3 py-4"
          steerTarget="any"
          steerSource="app-page"
          onFollowUp={followUp}
          requestText={threadRequestText}
          value={draft}
          onValueChange={setDraft}
          placeholder={placeholder}
          routeLabel={ROUTE_LABEL}
        />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6">
            <p className="max-w-xs text-center text-sm text-muted-foreground">
              {hasDispatchChain
                ? "No session yet. Your first message starts one."
                : "This thread has no onDispatch action chain, so it cannot start a session."}
            </p>
          </div>
          <ComposerDock
            value={draft}
            onChange={setDraft}
            onSubmit={() => void start()}
            isPending={starting}
            isError={startError !== null}
            errorMessage={startError ?? undefined}
            placeholder={userId ? placeholder : "Pick an identity to send messages."}
            disabled={!userId || !hasDispatchChain}
            routeLabel={ROUTE_LABEL}
            sendLabel="Start session"
          />
        </>
      )}
    </div>
  );
}
