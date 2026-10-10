/**
 * Parent side of the page feedback overlay (`src/artifact-sdk/feedback-overlay.ts`).
 *
 * Inside the dashboard, the overlay does not call the API itself. It hands the
 * collected comments to this page over postMessage, and the SPA sends them
 * with its own bearer. The page iframe therefore needs no viewer session, so a
 * public page stays unauthenticated while feedback mode is on.
 *
 * Protocol (message types are duplicated in the overlay script):
 *   iframe → parent  `swarm-feedback:hello`                       overlay mounted
 *   parent → iframe  `swarm-feedback:host`                        use the bridge
 *   iframe → parent  `swarm-feedback:send`   { requestId, payload }
 *   parent → iframe  `swarm-feedback:result` { requestId, ok, taskUrl?, error? }
 *
 * Only messages from the page iframe's own window and the API origin count.
 * The page id always comes from the route, never from the message. A send is
 * only a request: the viewer confirms it in the dashboard (`pending` +
 * `confirm` / `cancel`), so a page script cannot create a task on its own.
 *
 * The task is a session about this page: a `ui` root task under the page's
 * session-panel key, requested by the current user. After the send, the
 * contextual session panel opens on it.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { PageFeedbackPayload } from "@/api/types";
import { useContextPanel } from "@/components/context-panel/context-panel-state";
import { newSessionContextKey } from "@/components/session-panel";
import { useCurrentUser } from "@/contexts/current-user-context";

const HELLO = "swarm-feedback:hello";
const HOST = "swarm-feedback:host";
const SEND = "swarm-feedback:send";
const RESULT = "swarm-feedback:result";

type BridgeResult = { ok: boolean; taskUrl?: string; error?: string };

export interface PendingFeedback {
  payload: PageFeedbackPayload;
  /** Number of element comments, for the confirmation copy. */
  count: number;
}

export function usePageFeedbackBridge({
  pageId,
  pageKey,
  enabled,
  apiOrigin,
  iframeRef,
}: {
  pageId: string | undefined;
  /** Session-panel page key for the current route (`getPageContext`), if any. */
  pageKey: string | undefined;
  /** True only while the viewer has feedback mode on. */
  enabled: boolean;
  apiOrigin: string;
  iframeRef: RefObject<HTMLIFrameElement | null>;
}) {
  const { userId } = useCurrentUser();
  const { focusSession } = useContextPanel();
  const [pending, setPending] = useState<PendingFeedback | null>(null);
  const [sending, setSending] = useState(false);
  // Reply channel for the request waiting on the viewer's decision.
  const replyRef = useRef<((result: BridgeResult) => void) | null>(null);

  useEffect(() => {
    if (!enabled || !pageId) return;

    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || event.source !== frame || event.origin !== apiOrigin) return;
      const data = event.data as { type?: unknown; requestId?: unknown; payload?: unknown } | null;
      if (!data || typeof data !== "object") return;

      if (data.type === HELLO) {
        frame.postMessage({ type: HOST }, apiOrigin);
        return;
      }
      if (data.type !== SEND) return;

      const reply = (result: BridgeResult) =>
        frame.postMessage({ type: RESULT, requestId: data.requestId, ...result }, apiOrigin);
      const payload = data.payload as PageFeedbackPayload | null;
      if (replyRef.current || !payload || !Array.isArray(payload.comments)) {
        reply({ ok: false, error: "A send is already waiting for confirmation." });
        return;
      }
      replyRef.current = reply;
      setPending({ payload, count: payload.comments.length });
    }

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      replyRef.current?.({ ok: false, error: "Feedback mode was turned off." });
      replyRef.current = null;
      setPending(null);
    };
  }, [pageId, enabled, apiOrigin, iframeRef]);

  const settle = useCallback((result: BridgeResult) => {
    replyRef.current?.(result);
    replyRef.current = null;
    setPending(null);
  }, []);

  const cancel = useCallback(() => {
    settle({ ok: false, error: "Cancelled in the dashboard." });
  }, [settle]);

  const confirm = useCallback(async () => {
    if (!pending || !pageId) return;
    setSending(true);
    try {
      // The API validates the payload shape; a malformed one comes back as 400.
      const result = await api.sendPageFeedback(pageId, {
        ...pending.payload,
        contextKey: pageKey ? newSessionContextKey(pageKey) : undefined,
        requestedByUserId: userId ?? undefined,
      });
      settle({ ok: true, taskUrl: `${window.location.origin}/sessions/${result.taskId}` });
      if (pageKey) focusSession(pageKey, result.taskId);
    } catch (error) {
      settle({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setSending(false);
    }
  }, [pending, pageId, pageKey, userId, focusSession, settle]);

  return { pending, sending, confirm, cancel };
}
