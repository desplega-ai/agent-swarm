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
 * - `attachments` set: both composers take files (attach button, drop, paste)
 *   within its limits. A send uploads them to `attachments.dir` with the
 *   viewer's agent-fs key first, then runs `onDispatch` with
 *   `$form = { message, attachments: [{ path, name, mimeType, size }] }`. A
 *   failed upload sends nothing and keeps the text and files. Files never
 *   steer: a box with files sends a follow-up. The person bubble shows the
 *   `input.attachments` of each app action prompt as chips. While the
 *   viewer's browser has no working agent-fs key, a box above the composer
 *   gives the steps to connect, with Comb's connect dialog one click away.
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
import { Paperclip, SquarePen } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { SESSION_LIST_KEY, useSession, useSessions } from "@/api/hooks/use-sessions";
import type { AgentTask } from "@/api/types";
import { ConnectDialog, useEmbeddedFrame } from "@/components/comb/connect-dialog";
import { ComposerDock, DEFAULT_ATTACHMENT_LIMITS } from "@/components/sessions/composer-dock";
import { SessionConversation } from "@/components/sessions/session-conversation";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import { useCurrentUser } from "@/contexts/current-user-context";
import { CHAT_COLUMN } from "@/lib/chat-width";
import { cn } from "@/lib/utils";
import { useAppScopeId } from "./app-scope";
import type { ActionChain, swarmCatalog } from "./catalog";
import { useFormFileUploader } from "./form-file";
import { ThreadMessageFiles } from "./session-thread-files";
import {
  dispatchAppId,
  isDispatchSettled,
  isValidSessionKey,
  pickSessionRoot,
  runDispatchChain,
  threadAttachmentConfig,
  threadContextKey,
  threadRequestAttachments,
  threadRequestText,
  uploadThreadAttachments,
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

/** The chips of a person bubble (`SessionConversation`'s `requestFiles`). */
function threadRequestFiles(task: AgentTask): ReactNode {
  const files = threadRequestAttachments(task);
  return files.length > 0 ? <ThreadMessageFiles files={files} /> : null;
}

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

/**
 * Steps to connect agent-fs, above the composer of a thread that takes files,
 * while this browser has no working key. Connecting unmounts it. Not in an
 * embedded frame, where a key does not persist: the send error stays there.
 */
function ConnectFilesHint() {
  const agentFs = useOptionalAgentFs();
  const embedded = useEmbeddedFrame();
  const [open, setOpen] = useState(false);
  const needsKey = agentFs?.state === "needs-connect" || agentFs?.state === "invalid-key";
  if (!needsKey || embedded) return null;
  return (
    // Shrinks and scrolls so a composer grown by files keeps Send in the fixed-height thread;
    // `relative` and the fill cover a session timeline squeezed to its padded scroller.
    <div className="relative min-h-0 overflow-y-auto [scrollbar-gutter:auto] bg-background px-4 pt-2">
      <AlertCallout
        tone="info"
        icon={Paperclip}
        role="note"
        title="Connect your files to send attachments"
        className={CHAT_COLUMN}
      >
        <ol className="list-decimal space-y-0.5 pl-4">
          <li>Press Connect Files.</li>
          <li>Wait a few seconds.</li>
          <li>Press Send again.</li>
        </ol>
        <Button type="button" size="sm" className="mt-2" onClick={() => setOpen(true)}>
          Connect Files
        </Button>
      </AlertCallout>
      <ConnectDialog open={open} onOpenChange={setOpen} />
    </div>
  );
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
  const [startFiles, setStartFiles] = useState<File[]>([]);
  const upload = useFormFileUploader();
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
  const attachments = threadAttachmentConfig(props.attachments, DEFAULT_ATTACHMENT_LIMITS);
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
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  /**
   * Uploads the files (with the `attachments` prop), then runs `onDispatch`.
   * Returns the new task's id when one was created (the send waits for it to
   * show up), else null.
   */
  const dispatch = async (message: string, leafTaskId: string | null, files: File[]) => {
    const onDispatch = propsRef.current.onDispatch as ActionChain | undefined;
    if (!onDispatch || onDispatch.length === 0) {
      throw new Error("This thread has no onDispatch action chain.");
    }
    if (!sessionKey) throw new Error("This thread has no valid sessionKey.");
    const config = threadAttachmentConfig(propsRef.current.attachments, DEFAULT_ATTACHMENT_LIMITS);
    const uploaded = config
      ? await uploadThreadAttachments({ files, dir: config.dir, upload: uploadRef.current })
      : undefined;
    const { newTaskId } = await runDispatchChain({
      onDispatch,
      message,
      leafTaskId,
      attachments: uploaded,
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
    const files = attachments ? startFiles : [];
    try {
      const pendingTaskId = await dispatch(message, null, files);
      // Clear the draft only if it still holds the message that was sent.
      const current = getByPath(getSnapshotRef.current(), draftPath);
      if (typeof current === "string" && current.trim() === message) set(draftPath, "");
      if (files.length > 0) setStartFiles((held) => held.filter((file) => !files.includes(file)));
      if (pendingTaskId) await waitForTask(pendingTaskId);
    } catch (error) {
      setStartError(errorMessage(error, "Failed to send the message"));
    } finally {
      setStarting(false);
    }
  };

  /** `TaskComposer`'s follow-up: chain a new task off the leaf. */
  const followUp = async (message: string, parentTaskId: string | undefined, files: File[]) => {
    const loaded = detailRef.current;
    if (!loaded) throw new Error("The conversation is still loading.");
    if (loaded.chain.length === 0 || !parentTaskId) {
      throw new Error("Conversation not found — sending is disabled.");
    }
    const pendingTaskId = await dispatch(message, parentTaskId, files);
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
        // A phone stacks a `fill` parent, which leaves the thread a sliver: keep it usable.
        props.fill === true ? "h-full min-h-0 max-md:min-h-[420px]" : "h-[420px]",
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
          followUpAttachments={attachments?.limits}
          requestText={threadRequestText}
          requestFiles={attachments ? threadRequestFiles : undefined}
          value={draft}
          onValueChange={setDraft}
          placeholder={placeholder}
          routeLabel={ROUTE_LABEL}
          composerNotice={attachments ? <ConnectFilesHint /> : undefined}
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
          {attachments ? <ConnectFilesHint /> : null}
          <ComposerDock
            value={draft}
            onChange={setDraft}
            onSubmit={() => void start()}
            isPending={starting}
            attachments={attachments ? startFiles : undefined}
            onAttachmentsChange={attachments ? setStartFiles : undefined}
            attachmentLimits={attachments?.limits}
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
