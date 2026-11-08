import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { CODEX_ACCOUNTS_QUERY_KEY } from "@/api/hooks/use-codex-accounts";
import { ONBOARDING_QUERY_KEY } from "@/api/hooks/use-onboarding";
import type { CodexDeviceStartResponse } from "@/api/types";

export type CodexFlow =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "start_error"; error: string }
  | { phase: "polling"; flow: CodexDeviceStartResponse }
  | { phase: "complete"; slot?: number }
  | { phase: "failed"; error: string };

export const CODEX_EXPIRED_MESSAGE = "The code expired. Start again to get a new one.";
/** Consecutive failed poll requests before the flow stops and offers "Try again". */
const MAX_POLL_ERRORS = 3;

/**
 * The ChatGPT device sign-in (`POST /api/codex-oauth/device`, then poll
 * `/device/:flowId/poll`). Polls while the caller is mounted, until the code
 * expires. The API calls upstream at most once per interval, so a faster
 * tick only returns `pending`. A completed sign-in refreshes the accounts.
 */
export function useCodexDeviceFlow(onComplete?: () => void) {
  const queryClient = useQueryClient();
  const [flow, setFlow] = useState<CodexFlow>({ phase: "idle" });
  // The latest callback, so a new closure from the caller does not restart polling.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  /** Request a code. Resolves false when the API could not start a sign-in. */
  async function start(): Promise<boolean> {
    setFlow({ phase: "starting" });
    try {
      setFlow({ phase: "polling", flow: await api.startCodexDevice() });
      return true;
    } catch (err) {
      setFlow({
        phase: "start_error",
        error: err instanceof Error ? err.message : "Could not start the sign-in.",
      });
      return false;
    }
  }

  useEffect(() => {
    if (flow.phase !== "polling") return;
    const { flowId, intervalSeconds, expiresAt } = flow.flow;
    const delayMs = Math.max(2, intervalSeconds || 5) * 1000;
    const expiresAtMs = Date.parse(expiresAt);
    let cancelled = false;
    let errors = 0;
    let timer: number | undefined;

    const tick = async () => {
      if (Date.now() >= expiresAtMs) {
        setFlow({ phase: "failed", error: CODEX_EXPIRED_MESSAGE });
        return;
      }
      try {
        const res = await api.pollCodexDevice(flowId);
        if (cancelled) return;
        errors = 0;
        if (res.status === "complete") {
          setFlow({ phase: "complete", slot: res.slot });
          onCompleteRef.current?.();
          void queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
          void queryClient.invalidateQueries({ queryKey: ["configs"] });
          void queryClient.invalidateQueries({ queryKey: CODEX_ACCOUNTS_QUERY_KEY });
          return;
        }
        if (res.status === "failed" || res.status === "expired") {
          const fallback = res.status === "expired" ? CODEX_EXPIRED_MESSAGE : "Sign-in failed.";
          setFlow({ phase: "failed", error: res.error || fallback });
          void queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
          return;
        }
      } catch (err) {
        if (cancelled) return;
        // One failed request can be transient. Several in a row mean the API is gone.
        errors += 1;
        if (errors >= MAX_POLL_ERRORS) {
          const detail = err instanceof Error ? ` ${err.message}` : "";
          setFlow({ phase: "failed", error: `Could not check the sign-in.${detail}` });
          return;
        }
      }
      if (!cancelled) timer = window.setTimeout(tick, delayMs);
    };

    timer = window.setTimeout(tick, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [flow, queryClient]);

  return { flow, start, reset: () => setFlow({ phase: "idle" }) };
}
