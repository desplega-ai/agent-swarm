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
 * The page id always comes from the route, never from the message.
 */
import { type RefObject, useEffect } from "react";
import { api } from "@/api/client";
import type { PageFeedbackPayload } from "@/api/types";

const HELLO = "swarm-feedback:hello";
const HOST = "swarm-feedback:host";
const SEND = "swarm-feedback:send";
const RESULT = "swarm-feedback:result";

export function usePageFeedbackBridge({
  pageId,
  enabled,
  apiOrigin,
  iframeRef,
}: {
  pageId: string | undefined;
  /** True only while the viewer has feedback mode on. */
  enabled: boolean;
  apiOrigin: string;
  iframeRef: RefObject<HTMLIFrameElement | null>;
}) {
  useEffect(() => {
    if (!enabled || !pageId) return;
    let inFlight = false;

    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || event.source !== frame || event.origin !== apiOrigin) return;
      const data = event.data as { type?: unknown; requestId?: unknown; payload?: unknown } | null;
      if (!data || typeof data !== "object") return;

      if (data.type === HELLO) {
        frame.postMessage({ type: HOST }, apiOrigin);
        return;
      }
      if (data.type !== SEND || !pageId) return;

      const reply = (result: { ok: boolean; taskUrl?: string; error?: string }) =>
        frame.postMessage({ type: RESULT, requestId: data.requestId, ...result }, apiOrigin);
      if (inFlight) {
        reply({ ok: false, error: "A send is already in progress." });
        return;
      }
      inFlight = true;
      // The API validates the payload shape; a malformed one comes back as 400.
      api
        .sendPageFeedback(pageId, data.payload as PageFeedbackPayload)
        .then((result) =>
          reply({ ok: true, taskUrl: `${window.location.origin}/tasks/${result.taskId}` }),
        )
        .catch((error: unknown) =>
          reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        )
        .finally(() => {
          inFlight = false;
        });
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pageId, enabled, apiOrigin, iframeRef]);
}
