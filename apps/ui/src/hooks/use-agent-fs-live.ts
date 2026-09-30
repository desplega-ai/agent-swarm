// Comb live updates: one agent-fs change stream per tab, for the drive in
// view. Each event invalidates the queries it makes stale
// (`keysToInvalidate`), so open views refresh within about a second. While
// the stream is live, `stat`, `ls`, and comment queries stop polling
// (`useAgentFsAccess().liveDriveId`). Called once, in `AgentFsProvider`.

import { hashKey, type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentFsClient } from "@/lib/agent-fs/client";
import { keysToInvalidate } from "@/lib/agent-fs/invalidation";
import { type DriveEvent, type DriveStreamState, openDriveStream } from "@/lib/agent-fs/stream";

/**
 * `DriveStreamState`, plus:
 * - `off`: no stream (Comb is not ready, no drive is in view, or agent-fs
 *   lacks `change-stream`).
 * - `paused`: the tab was hidden for more than 5 minutes. The stream reopens
 *   when the tab is visible again.
 */
export type LiveState = "off" | "paused" | DriveStreamState;

export type LiveListener = (event: DriveEvent) => void;

export interface AgentFsLive {
  liveState: LiveState;
  /** The drive whose stream is `live`, else null. Its queries do not poll. */
  liveDriveId: string | null;
  /** Receive every stream event. Returns the unsubscribe function. */
  subscribeLive: (listener: LiveListener) => () => void;
}

/** Events that arrive within this window refresh their queries together. */
const BATCH_MS = 50;
const HIDDEN_CLOSE_MS = 5 * 60_000;

export function useAgentFsLive({
  client,
  endpoint,
  userId,
  orgId,
  driveId,
}: {
  /** Null unless Comb is `ready` and agent-fs lists `change-stream`. */
  client: AgentFsClient | null;
  endpoint: string | null;
  userId: string | null;
  /** The drive in view. Null off Comb pages. */
  orgId: string | null;
  driveId: string | null;
}): AgentFsLive {
  const queryClient = useQueryClient();
  const [streamState, setStreamState] = useState<DriveStreamState>("connecting");
  const hidden = useHiddenFor(HIDDEN_CLOSE_MS);
  const listeners = useRef(new Set<LiveListener>());
  const subscribeLive = useCallback((listener: LiveListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const enabled = client !== null && endpoint !== null && orgId !== null && driveId !== null;
  useEffect(() => {
    if (!client || endpoint === null || orgId === null || driveId === null || hidden) return;
    const controller = new AbortController();
    const ctx = { endpoint, userId, orgId, driveId };
    const pending = new Map<string, QueryKey>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      for (const queryKey of pending.values()) void queryClient.invalidateQueries({ queryKey });
      pending.clear();
    };
    void openDriveStream({
      client,
      orgId,
      driveId,
      signal: controller.signal,
      onState: setStreamState,
      onEvent: (event) => {
        for (const key of keysToInvalidate(event, ctx)) pending.set(hashKey(key), key);
        flushTimer ??= setTimeout(flush, BATCH_MS);
        for (const listener of listeners.current) listener(event);
      },
    });
    return () => {
      controller.abort();
      clearTimeout(flushTimer);
    };
  }, [client, endpoint, userId, orgId, driveId, hidden, queryClient]);

  const liveState: LiveState = !enabled ? "off" : hidden ? "paused" : streamState;
  return {
    liveState,
    liveDriveId: liveState === "live" ? driveId : null,
    subscribeLive,
  };
}

/** True once the tab has been hidden for `ms`. False again as soon as it is visible. */
function useHiddenFor(ms: number): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") timer = setTimeout(() => setHidden(true), ms);
      else setHidden(false);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [ms]);
  return hidden;
}
