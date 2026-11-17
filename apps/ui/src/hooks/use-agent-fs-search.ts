/**
 * Search the swarm's agent-fs drive for files, for pickers (avatar images
 * today, file mentions in the sessions input later). Wraps Comb's
 * `useCombSearch`, so results share its cache. Needs an `<AgentFsProvider>`.
 */

import { useMemo } from "react";
import { useCombSearch } from "@/api/hooks/use-agent-fs";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { hasFileExtension, isSearchable, type SearchHit, type SearchMode } from "@/lib/comb/search";

export interface AgentFsSearchOptions {
  /** `name` (default) matches file names; `text` and `semantic` match file contents. */
  mode?: SearchMode;
  /** Keep only files with one of these extensions (lowercase, no dot). Empty or unset keeps all. */
  extensions?: readonly string[];
}

export interface AgentFsSearch {
  /** The drive searched: the swarm drive, or null until agent-fs names it. */
  drive: { orgId: string; driveId: string } | null;
  hits: SearchHit[];
  /** False when nothing is searched: no drive, or the query is too short for the mode. */
  searchable: boolean;
  loading: boolean;
  error: boolean;
}

const NO_DRIVE = { orgId: "", driveId: "" };

export function useAgentFsSearch(query: string, options: AgentFsSearchOptions = {}): AgentFsSearch {
  const { orgId, driveId } = useAgentFs();
  const mode = options.mode ?? "name";
  const drive = useMemo(() => (orgId && driveId ? { orgId, driveId } : null), [orgId, driveId]);
  // No drive: an empty query keeps `useCombSearch` disabled.
  const result = useCombSearch(drive ?? NO_DRIVE, mode, drive ? query : "");
  const extensions = options.extensions;
  const hits = useMemo(
    () => (result.data?.hits ?? []).filter((hit) => hasFileExtension(hit.path, extensions ?? [])),
    [result.data, extensions],
  );
  return {
    drive,
    hits,
    searchable: drive !== null && isSearchable(mode, query),
    loading: result.isFetching,
    error: result.isError,
  };
}
