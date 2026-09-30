// Ported from agent-fs `live/src/hooks/use-comment-anchors.ts` (agent-fs
// commit 08e7d89). Comb changes: `useAgentFs()` access instead of live/'s
// `useAuth`, the version comes from the caller's `stat`, the diff key follows
// the Comb query-key contract, a missing `fileVersion` is read from the file's
// log (`anchorInputs`), a quote's end line is its last block's end line
// (`withBlockLineEnd`), and the result is returned instead of being published
// to a store (the comment rail owns it).

import { type QueryObserverResult, useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { agentFsDiffQuery, agentFsLogQuery, useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import type { CommentListEntry, DiffResult } from "@/lib/agent-fs/types";
import {
  type AnchorDiffChange,
  type AnchorResolution,
  anchorNeedsDiff,
  commentAnchorInput,
  diffHasLineNumbers,
  resolveAnchor,
} from "@/lib/comb/comment-anchor";
import { anchorInputs } from "@/lib/comb/comments";
import { type AnchorSpace, withBlockLineEnd } from "@/lib/comb/dom-text-space";
import type { DrivePath } from "@/lib/comb/paths";

/** One diff query: its changes, "pending" while it loads, null when unusable. */
type DiffOutcome = AnchorDiffChange[] | null | "pending";

// Module scope: `useQueries` re-runs `combine` when its identity changes. The
// combined array is structurally shared, so it keeps its identity until an
// outcome changes.
function combineDiffs(results: QueryObserverResult<DiffResult>[]): DiffOutcome[] {
  return results.map((q) => {
    if (q.isPending && q.fetchStatus !== "idle") return "pending";
    if (q.data && diffHasLineNumbers(q.data.changes)) return q.data.changes;
    return null; // failed, old server, or no versioning: resolve without
  });
}

/**
 * Resolve every anchored comment against the text the viewer shows, and fetch
 * the version diff only for comments the quote alone could not place.
 *
 * Returns `commentId → resolution` (`anchored | moved | lost`, plus text
 * offsets in `space`). File-level comments have no entry. A comment whose
 * diff is still loading has no entry instead of a false "lost".
 */
export function useCommentAnchors(
  file: DrivePath,
  comments: CommentListEntry[],
  space: AnchorSpace | null,
  currentVersion: number | undefined,
): Map<string, AnchorResolution> {
  const access = useAgentFsAccess();

  // Comments stored in the live/ form can come without `fileVersion` (see
  // `versionAt`): read it from the file's log, so their line ranges remap too.
  const needsLog = useMemo(
    () => comments.some((c) => c.fileVersion == null && commentAnchorInput(c, undefined)),
    [comments],
  );
  const log = useQuery({
    ...agentFsLogQuery(access, file, currentVersion),
    enabled: needsLog && access.client !== null && currentVersion !== undefined,
  });
  const logLoading = log.isPending && log.fetchStatus !== "idle";

  const inputs = useMemo(
    () =>
      anchorInputs(comments, currentVersion, {
        loading: logLoading,
        versions: log.data?.versions,
      }),
    [comments, currentVersion, log.data, logLoading],
  );

  const firstPass = useMemo(() => {
    const out = new Map<string, AnchorResolution>();
    if (space) for (const { id, input } of inputs) out.set(id, resolveAnchor(space, input));
    return out;
  }, [inputs, space]);

  // Versions worth diffing: stale comments with a line range that the quote
  // didn't place unambiguously.
  const neededVersions = useMemo(() => {
    const set = new Set<number>();
    for (const { id, version, input } of inputs) {
      if (version == null || input.lineStart == null) continue;
      if (!anchorNeedsDiff(firstPass.get(id))) continue;
      set.add(version);
    }
    return [...set].sort((a, b) => a - b);
  }, [inputs, firstPass]);

  const diffs = useQueries({
    queries: neededVersions.map((v) => agentFsDiffQuery(access, file, v, currentVersion ?? 0)),
    combine: combineDiffs,
  });

  return useMemo(() => {
    if (!space) return firstPass;
    const byVersion = new Map<number, DiffOutcome>();
    neededVersions.forEach((v, i) => {
      byVersion.set(v, diffs[i] ?? null);
    });
    const out = new Map(firstPass);
    for (const { id, version, input } of inputs) {
      if (version == null || !byVersion.has(version)) continue;
      const changes = byVersion.get(version);
      if (changes === "pending") {
        // Hold back "lost" while a diff that could still place it loads.
        if (out.get(id)?.status === "lost") out.delete(id);
        continue;
      }
      out.set(id, resolveAnchor(space, { ...input, changes }));
    }
    for (const [id, resolution] of out) out.set(id, withBlockLineEnd(space, resolution));
    return out;
  }, [firstPass, inputs, neededVersions, diffs, space]);
}
