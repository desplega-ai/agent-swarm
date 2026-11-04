import { useCallback, useEffect, useState } from "react";
// The alias (not "./") lets the `/setup` Files step test swap the real calls.
import { useConnectFlowDeps } from "@/components/comb/use-connect-flow-deps";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { browserKeyLabel } from "@/lib/agent-fs/key-label";
import { autoConnectRunKey, currentAttempt, startAttempt } from "./auto-connect-attempts";
import { type AutoConnectOutcome, autoConnect } from "./connect-flow";

// One automatic attempt per swarm, agent-fs endpoint, and dashboard user per
// page load (`auto-connect-attempts.ts`), so a key that agent-fs keeps
// rejecting never mints in a loop. Retry starts a new attempt on purpose.
export { _resetAutoConnectAttemptsForTests } from "./auto-connect-attempts";

export interface AutoConnect {
  /** The last attempt's outcome. Null while none has settled. */
  outcome: AutoConnectOutcome | null;
  /** An attempt is in flight. */
  running: boolean;
  /** Start a new attempt (the Retry and Reconnect buttons). */
  retry: () => void;
}

/**
 * Connect this browser with no click: with no saved key, or a saved key that
 * agent-fs rejects, mint a named key through the swarm and save it.
 * `enabled: false` starts no attempt (a surface that may not need Files).
 */
export function useAutoConnect({ enabled = true }: { enabled?: boolean } = {}): AutoConnect {
  const { state, endpoint } = useAgentFs();
  const deps = useConnectFlowDeps();
  const { apiUrl } = useConfig().config;
  // The minted key belongs to the dashboard user, so the attempt does too.
  const { userId } = useCurrentUser();
  const runKey = autoConnectRunKey(apiUrl, endpoint, userId);
  const [outcome, setOutcome] = useState<AutoConnectOutcome | null>(null);
  const [pending, setPending] = useState<Promise<AutoConnectOutcome> | null>(null);
  const wantsKey = enabled && (state === "needs-connect" || state === "invalid-key");

  // Start (or join) this page load's attempt.
  useEffect(() => {
    if (!deps || !runKey || !wantsKey) return;
    const attempt =
      currentAttempt(runKey) ?? startAttempt(runKey, () => autoConnect(deps, browserKeyLabel()));
    setPending(attempt);
  }, [deps, runKey, wantsKey]);

  // Follow the attempt in view until it settles.
  useEffect(() => {
    if (!pending) return;
    let live = true;
    void pending.then((next) => {
      if (!live) return;
      setOutcome(next);
      setPending((current) => (current === pending ? null : current));
    });
    return () => {
      live = false;
    };
  }, [pending]);

  const retry = useCallback(() => {
    if (!deps || !runKey) return;
    const attempt = startAttempt(runKey, () => autoConnect(deps, browserKeyLabel()));
    setOutcome(null);
    setPending(attempt);
  }, [deps, runKey]);

  return { outcome, running: pending !== null, retry };
}
