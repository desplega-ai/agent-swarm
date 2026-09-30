// Comb live updates: the agent-fs change stream for the drive in view. Each
// event invalidates the queries it makes stale (`keysToInvalidate`, applied
// by `createLiveBatcher`), so open views refresh within about a second.
// While the stream is live, the `LIVE_QUERY_KINDS` queries stop polling
// (`drivePoll`). On an `http:` agent-fs the tabs of a browser share one
// stream per drive (`openSharedDriveStream`). Called once, in `AgentFsProvider`.

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentFsClient } from "@/lib/agent-fs/client";
import { keysToInvalidate } from "@/lib/agent-fs/invalidation";
import { createLiveBatcher, watchHidden } from "@/lib/agent-fs/live-batcher";
import type { DriveEvent, DriveStreamState } from "@/lib/agent-fs/stream";
import { browserStreamShare, openSharedDriveStream } from "@/lib/agent-fs/stream-share";

/**
 * `DriveStreamState`, plus:
 * - `off`: no stream (Comb is not ready, no drive is in view, or agent-fs
 *   lacks `change-stream`).
 * - `paused`: the tab was hidden for more than 10 s. The stream reopens
 *   when the tab is visible again.
 */
export type LiveState = "off" | "paused" | DriveStreamState;

export type LiveListener = (event: DriveEvent) => void;

export interface AgentFsLive {
  liveState: LiveState;
  /** True when the state is another tab's stream, which this tab follows (`http:` agent-fs only). */
  liveRelayed: boolean;
  /** The drive whose stream is `live`, else null. See `drivePoll`. */
  liveDriveId: string | null;
  /** Receive every stream event. Returns the unsubscribe function. */
  subscribeLive: (listener: LiveListener) => () => void;
}

/**
 * A tab hidden this long closes its stream, so background tabs hold no
 * connection. The `ready` resync refreshes the view when it opens again.
 */
const HIDDEN_CLOSE_MS = 10_000;

/** One stream: the lock and channel name, and the owner of a stream state. */
function streamName(endpoint: string, userId: string | null, orgId: string, driveId: string) {
  return `comb-live ${endpoint} ${userId} ${orgId}/${driveId}`;
}

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
  // Keyed by stream, so another drive never shows this one's state.
  const [stream, setStream] = useState<{
    name: string;
    state: DriveStreamState;
    relayed: boolean;
  } | null>(null);
  const hidden = useHiddenFor(HIDDEN_CLOSE_MS);
  const listeners = useRef(new Set<LiveListener>());
  const subscribeLive = useCallback((listener: LiveListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!client || endpoint === null || orgId === null || driveId === null || hidden) return;
    const name = streamName(endpoint, userId, orgId, driveId);
    const controller = new AbortController();
    const ctx = { endpoint, userId, orgId, driveId };
    const batcher = createLiveBatcher({ queryClient });
    void openSharedDriveStream({
      client,
      orgId,
      driveId,
      signal: controller.signal,
      // HTTP/1.1 allows 6 connections per host, so the tabs share one stream.
      share: endpoint.startsWith("http:") ? browserStreamShare(name) : null,
      onState: (state, relayed) => setStream({ name, state, relayed }),
      onEvent: (event) => {
        batcher.add(keysToInvalidate(event, ctx));
        for (const listener of listeners.current) listener(event);
      },
    });
    return () => {
      controller.abort();
      batcher.dispose();
      setStream(null);
    };
  }, [client, endpoint, userId, orgId, driveId, hidden, queryClient]);

  const name =
    client && endpoint !== null && orgId !== null && driveId !== null
      ? streamName(endpoint, userId, orgId, driveId)
      : null;
  const current = stream !== null && stream.name === name ? stream : null;
  const liveState: LiveState =
    name === null ? "off" : hidden ? "paused" : (current?.state ?? "connecting");
  return {
    liveState,
    liveRelayed: liveState === "live" && current?.relayed === true,
    liveDriveId: liveState === "live" ? driveId : null,
    subscribeLive,
  };
}

/** True once the tab has been hidden for `ms`. False again as soon as it is visible. */
function useHiddenFor(ms: number): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => watchHidden({ doc: document, ms, onChange: setHidden }), [ms]);
  return hidden;
}
