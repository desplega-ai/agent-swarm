// Ported from agent-fs `live/src/hooks/use-comment-anchors.ts` (agent-fs
// commit 08e7d89). Comb changes: `useAgentFs()` access instead of live/'s
// `useAuth`, the version comes from the caller's `stat`, the diff key follows
// the Comb query-key contract, a missing `fileVersion` is read from the file's
// log, and the result is returned instead of being published to a store (the
// comment rail owns it).

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { agentFsDiffQuery, agentFsLogQuery, useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import type { CommentListEntry } from "@/lib/agent-fs/types";
import {
  type AnchorDiffChange,
  type AnchorInput,
  type AnchorResolution,
  anchorNeedsDiff,
  commentAnchorInput,
  diffHasLineNumbers,
  resolveAnchor,
  type TextSpace,
} from "@/lib/comb/comment-anchor";
import { versionAt } from "@/lib/comb/comments";
import type { DrivePath } from "@/lib/comb/paths";

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
  space: TextSpace | null,
  currentVersion: number | undefined,
): Map<string, AnchorResolution> {
  const access = useAgentFsAccess();

  // Comments stored in the live/ form come without `fileVersion` (see
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

  const inputs = useMemo(() => {
    const out: Array<{ id: string; version?: number; input: AnchorInput }> = [];
    for (const c of comments) {
      let fileVersion = c.fileVersion;
      if (fileVersion == null) {
        // Hold the comment back rather than trust its stored lines too early.
        if (logLoading) continue;
        fileVersion = log.data ? versionAt(log.data.versions, c.createdAt) : undefined;
      }
      const entry = commentAnchorInput({ ...c, fileVersion }, currentVersion);
      if (entry) out.push({ id: c.id, ...entry }); // null: general comment, nothing to anchor
    }
    return out;
  }, [comments, currentVersion, log.data, logLoading]);

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
  });
  // `diffs` is a new array every render: this string stands in for it.
  const diffsKey = diffs.map((q) => `${q.status}:${q.fetchStatus}:${q.dataUpdatedAt}`).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: diffsKey stands in for diffs.
  return useMemo(() => {
    if (!space) return firstPass;
    const byVersion = new Map<number, AnchorDiffChange[] | null | "pending">();
    neededVersions.forEach((v, i) => {
      const q = diffs[i];
      if (q?.isPending && q.fetchStatus !== "idle") byVersion.set(v, "pending");
      else if (q?.data && diffHasLineNumbers(q.data.changes)) byVersion.set(v, q.data.changes);
      else byVersion.set(v, null); // failed, old server, or no versioning: resolve without
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
    return out;
  }, [firstPass, inputs, neededVersions, diffsKey, space]);
}
