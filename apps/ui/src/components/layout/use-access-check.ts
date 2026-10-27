import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  accessId,
  isAccessEnded,
  setAccessEnded,
  subscribeEndedAccess,
  subscribeKeyRejection,
} from "@/api/access-rejection";
import { api } from "@/api/client";
import { useConfig } from "@/hooks/use-config";

/** One check for a burst of 401s: the shell sends many requests at once. */
const PROBE_DELAY_MS = 250;

export interface AccessCheck {
  /** A check confirmed that the API rejects the saved key of the active connection. */
  ended: boolean;
  /** A check runs. */
  checking: boolean;
  /** Check again. When the key works again, the shell comes back and every query refetches. */
  retry: () => void;
}

/**
 * Watches the 401s of the active connection (`api/access-rejection.ts`). The
 * first one starts one check (`api.checkAccess`). Only a 401 on that check
 * ends access, so a single route that answers 401 never locks the shell.
 * While access is ended, a return to the tab (focus) checks again. A network
 * failure keeps the current state.
 */
export function useAccessCheck(): AccessCheck {
  const { config } = useConfig();
  const queryClient = useQueryClient();
  const { apiUrl, apiKey } = config;
  const id = accessId({ apiUrl, apiKey });
  const ended = useSyncExternalStore(subscribeEndedAccess, () => isAccessEnded(id));
  const [checking, setChecking] = useState(false);
  const running = useRef(false);

  const probe = useCallback(async () => {
    if (running.current || !apiKey) return;
    running.current = true;
    setChecking(true);
    try {
      const result = await api.checkAccess({ apiUrl, apiKey });
      if (result === "rejected") {
        setAccessEnded(id, true);
      } else if (isAccessEnded(id)) {
        setAccessEnded(id, false);
        void queryClient.invalidateQueries();
      }
    } catch {
      // No answer (offline, the API restarts): keep what is shown now.
    } finally {
      running.current = false;
      setChecking(false);
    }
  }, [apiUrl, apiKey, id, queryClient]);

  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = subscribeKeyRejection((rejected) => {
      if (rejected !== id || isAccessEnded(id) || running.current || timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void probe();
      }, PROBE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [id, probe]);

  useEffect(() => {
    if (!ended) return;
    const onReturn = () => {
      if (document.visibilityState === "visible") void probe();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [ended, probe]);

  const retry = useCallback(() => {
    void probe();
  }, [probe]);

  return { ended, checking, retry };
}
