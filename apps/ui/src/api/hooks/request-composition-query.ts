import { keepPreviousData } from "@tanstack/react-query";
import type { CompositionManifest } from "../../lib/request-composition";

/** A known session has no manifest yet: its worker manifest is due. */
export const COMPOSITION_MISSING_POLL_MS = 15_000;
/**
 * Every session has a manifest. A harness hook can still post a later seq
 * (after its first call, or when the tool set changes), so keep a slow poll.
 */
export const COMPOSITION_LIVE_POLL_MS = 60_000;

export interface RequestCompositionQueryInput {
  enabled: boolean;
  sessionIds: string[];
  live: boolean;
}

export function compositionPollMs(
  manifests: CompositionManifest[] | undefined,
  sessionIds: string[],
  live: boolean,
): number | false {
  if (!live) return false;
  const have = new Set((manifests ?? []).map((m) => m.sessionId));
  return sessionIds.some((s) => !have.has(s))
    ? COMPOSITION_MISSING_POLL_MS
    : COMPOSITION_LIVE_POLL_MS;
}

/**
 * The read reruns when the log shows a new session. `useRequestComposition`
 * reads once more when the task ends, so a manifest posted after the last poll
 * still shows.
 */
export function requestCompositionQuery(
  taskId: string,
  opts: RequestCompositionQueryInput,
  fetchManifests: (taskId: string) => Promise<CompositionManifest[]>,
) {
  const sessionKey = [...opts.sessionIds].sort().join(",");
  return {
    queryKey: ["task", taskId, "request-composition", sessionKey],
    queryFn: () => fetchManifests(taskId),
    enabled: !!taskId && opts.enabled,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
    refetchInterval: (query: { state: { data: CompositionManifest[] | undefined } }) =>
      compositionPollMs(query.state.data, opts.sessionIds, opts.live),
  };
}
