/**
 * `SessionThread` — a chat on an app page, rendered with the same Sessions v2
 * pieces as the "Session about this page" side panel.
 *
 * The session is found by key, the way the panel finds its sessions: every
 * task an `onDispatch` `app.action` step creates carries the thread's
 * `session` (`{ key: sessionKey, scope }`), and the server keys it as
 * `task:app:<appId>:<sessionKey>:user:<requester>` (`appSessionContextKey`).
 * The thread lists the viewer's sessions with that exact context key
 * (`useSessions`) and shows the newest root. No row stores a root id, and a
 * page cannot write into another app's or person's sessions: the server
 * builds the key from the app the action runs on and the resolved requester.
 *
 * `scope: "shared"` is reserved and rejected by the page validator and the
 * server. Planned (follow-up PR): one session for everyone, made shared by an
 * everyone:write `session_shares` row the server adds to the root when it
 * creates it.
 *
 * - No identity picked: a notice and a disabled composer (the session is per
 *   person, so the server would refuse the send).
 * - No session yet: the panel's new-session look (a hint, then the shared
 *   `ComposerDock`). A send runs `onDispatch` with `$form = { message }` and
 *   `$chain = { leafTaskId: null, newTaskId: null }` — explicit absence, so a
 *   `parentTaskId: { "$chain": "leafTaskId" }` param is dropped and the
 *   task becomes the session's root.
 * - A session: the shared `SessionConversation` (turn timeline, "Latest"
 *   jump, `TaskComposer`), with the app keeping control of sends:
 *   - steer: the newest unfinished task of ANY agent (`steerTarget="any"`),
 *     attributed `source: "app-page"`.
 *   - follow up: `onFollowUp` runs `onDispatch` again with
 *     `$chain.leafTaskId` = the composer's target, so the new task chains off
 *     the leaf (and inherits the session's context key server-side).
 *   - person bubbles show the `input.message` of each app action prompt.
 * - "New session": the next message starts a new root, and the thread shows
 *   only roots created after the current one from then on. Nothing is
 *   deleted; the older session stays in the Sessions list.
 *
 * Each `app.action` step goes out with the session and `followUp: false`
 * (unless the step sets `followUp`), so the Lead adds no review task.
 *
 * After a dispatch that created a task, the send stays pending until the new
 * task shows up (as the session root, or in its chain), up to
 * `PENDING_DISPATCH_TIMEOUT_MS`, so a quick second message cannot chain off
 * the old leaf or start a second root.
 *
 * The composer draft is mirrored to `/ui/<id>/value`, so it survives
 * re-renders and other elements can bind it. Inside an element instance the
 * assembler namespaces `id`, so two instances keep separate drafts.
 */

import { getByPath, type InferComponentProps } from "@json-render/core";
import { useActions, useStateStore } from "@json-render/react";
import { useQueryClient } from "@tanstack/react-query";
import { SquarePen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { SESSION_LIST_KEY, useSession, useSessions } from "@/api/hooks/use-sessions";
import type { AgentTask } from "@/api/types";
import { ComposerDock } from "@/components/sessions/composer-dock";
import { SessionConversation } from "@/components/sessions/session-conversation";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/contexts/current-user-context";
import { cn } from "@/lib/utils";
import { useAppScopeId } from "./app-scope";
import type { ActionChain, swarmCatalog } from "./catalog";
import {
  dispatchAppId,
  isDispatchSettled,
  isValidSessionKey,
  pickSessionRoot,
  runDispatchChain,
  threadContextKey,
  threadRequestText,
} from "./session-thread-model";

export type SessionThreadProps = InferComponentProps<typeof swarmCatalog, "SessionThread">;

/** `contextKeyPrefix` on `GET /api/sessions`. */
const SESSIONS_MIN_VERSION = "1.157.1";

/**
 * Longest wait for a sent task to show up before the send settles anyway, so
 * a lagging list cannot lock the composer.
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
 * `waitForTask(id)` resolves once the dispatched task `id` is the session
 * root or in its chain (`isDispatchSettled`), or after the timeout.
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

/** A notice in place of the conversation, over a disabled composer. */
function DisabledThread({
  notice,
  draft,
  onDraft,
  placeholder,
}: {
  notice: string;
  draft: string;
  onDraft: (next: string) => void;
  placeholder: string;
}) {
  return (
    <>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6">
        <p className="max-w-xs text-center text-sm text-muted-foreground" aria-live="polite">
          {notice}
        </p>
      </div>
      <ComposerDock
        value={draft}
        onChange={onDraft}
        onSubmit={() => {}}
        isPending={false}
        placeholder={placeholder}
        disabled
        routeLabel={ROUTE_LABEL}
      />
    </>
  );
}

export function SessionThreadComponent({ props }: { props: SessionThreadProps }) {
  const { state, set, getSnapshot } = useStateStore();
  const { execute } = useActions();
  const { userId } = useCurrentUser();
  const queryClient = useQueryClient();
  const gate = useFeatureGate(SESSIONS_MIN_VERSION);
  const pageAppId = useAppScopeId();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // "New session": only roots created after this one's `createdAt` count. Kept
  // per context key, so another app, key or viewer starts without a cutoff.
  const [cutoff, setCutoff] = useState<{ contextKey: string; after: string } | null>(null);

  const draftPath = `/ui/${props.id}/value`;
  const stored = getByPath(state, draftPath);
  const draft = typeof stored === "string" ? stored : "";
  const setDraft = (next: string) => set(draftPath, next);

  const onDispatchChain = props.onDispatch as ActionChain | undefined;
  const hasDispatchChain = Array.isArray(onDispatchChain) && onDispatchChain.length > 0;
  const placeholder = props.placeholder ?? "Send a message…";
  const scope = props.scope === "shared" ? "shared" : "user";
  const sessionKey = isValidSessionKey(props.sessionKey) ? props.sessionKey : null;
  const appId = dispatchAppId(onDispatchChain, pageAppId);
  const contextKey =
    appId && sessionKey && userId ? threadContextKey(appId, sessionKey, userId) : null;
  const lookupReady = gate.supported && scope === "user" && contextKey !== null;
  const newerThan = cutoff !== null && cutoff.contextKey === contextKey ? cutoff.after : null;

  const list = useSessions({
    contextKeyPrefix: contextKey ?? undefined,
    requestedByUserId: userId ?? undefined,
    limit: 20,
    enabled: lookupReady,
  });
  const root =
    lookupReady && list.data
      ? pickSessionRoot(
          list.data.sessions.map((item) => item.root),
          contextKey,
          newerThan,
        )
      : null;
  const rootTaskId = root?.id ?? "";
  const { data: detail, isError: loadFailed } = useSession(rootTaskId || undefined);
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

  /**
   * Runs `onDispatch`. Returns the new task's id when one was created (the
   * send waits for it to show up), else null.
   */
  const dispatch = async (message: string, leafTaskId: string | null) => {
    const onDispatch = propsRef.current.onDispatch as ActionChain | undefined;
    if (!onDispatch || onDispatch.length === 0) {
      throw new Error("This thread has no onDispatch action chain.");
    }
    if (!sessionKey) throw new Error("This thread has no valid sessionKey.");
    const { newTaskId } = await runDispatchChain({
      onDispatch,
      message,
      leafTaskId,
      session: { key: sessionKey, scope },
      execute: executeRef.current,
      getSnapshot: getSnapshotRef.current,
    });
    void queryClient.invalidateQueries({ queryKey: SESSION_LIST_KEY });
    void queryClient.invalidateQueries({ queryKey: ["session"] });
    return newTaskId ?? null;
  };

  /** The first message: the session's root task. */
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

  const notice = !sessionKey
    ? "This thread has no valid sessionKey."
    : scope === "shared"
      ? "Shared sessions are not supported yet."
      : !appId
        ? "This chat only works on an app page."
        : !userId
          ? "Pick an identity to chat."
          : !list.data
            ? list.isError
              ? "Your sessions could not be loaded — sending is disabled."
              : "Loading the conversation…"
            : rootTaskId && !detail
              ? loadFailed
                ? "The conversation could not be loaded — sending is disabled."
                : "Loading the conversation…"
              : rootTaskId && detail && detail.chain.length === 0
                ? "Conversation not found — sending is disabled."
                : null;

  if (!gate.supported) {
    return (
      <div
        className="min-w-0 rounded-xl border border-border bg-card p-4"
        data-testid="json-render-session-thread"
      >
        <p className="text-sm text-muted-foreground">
          This chat requires API ≥ {gate.requiredVersion}
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
      {root && !notice ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={starting}
            onClick={() => contextKey && setCutoff({ contextKey, after: root.createdAt })}
            aria-label="New session"
            className="ml-auto h-6 gap-1 px-2 text-xs text-muted-foreground"
          >
            <SquarePen className="h-3 w-3" />
            New session
          </Button>
        </div>
      ) : null}
      {notice ? (
        <DisabledThread
          notice={notice}
          draft={draft}
          onDraft={setDraft}
          placeholder={placeholder}
        />
      ) : rootTaskId ? (
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
            placeholder={placeholder}
            disabled={!hasDispatchChain}
            routeLabel={ROUTE_LABEL}
            sendLabel="Start session"
          />
        </>
      )}
    </div>
  );
}
