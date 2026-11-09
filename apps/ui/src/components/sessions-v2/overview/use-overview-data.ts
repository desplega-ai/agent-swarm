/**
 * The data behind a use-case Overview (step-10): the schedules whose runs
 * file into the group, the files under its key in the shared drive, and
 * whether the group gets an Overview tab at all.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/api/client";
import { agentFsLsQuery, useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import type { ScheduledTask } from "@/api/types";
import { useAutoConnect } from "@/components/comb/use-auto-connect";
import { useAgentFs } from "@/contexts/agent-fs-context";
import type { LsEntry } from "@/lib/agent-fs/types";
import {
  canHaveOverview,
  groupDrivePath,
  outputFiles,
  overviewQualifies,
  schedulesInGroup,
  sortSchedules,
} from "@/lib/use-case-overview";

/**
 * The schedules of a group. One `keyPrefix` read (full rows, templates
 * included), cut to the schedules whose runs file into this group. The key
 * starts with `scheduled-tasks`, so every schedule mutation refreshes it.
 */
export function useGroupSchedules(groupKey: string | null) {
  const filters = { keyPrefix: groupKey ?? "" };
  const query = useQuery({
    queryKey: ["scheduled-tasks", filters],
    queryFn: () => api.fetchScheduledTasks(filters),
    enabled: groupKey !== null,
  });
  const all = query.data?.scheduledTasks as ScheduledTask[] | undefined;
  const schedules = useMemo(
    () => (groupKey && all ? sortSchedules(schedulesInGroup(all, groupKey)) : undefined),
    [all, groupKey],
  );
  return { schedules, isError: query.isError, isPending: groupKey !== null && query.isPending };
}

export interface GroupFiles {
  /** The files under the key, newest first. Undefined while they load. */
  files: LsEntry[] | undefined;
  /** Files is off (Comb disabled): the Outputs widget hides. */
  off: boolean;
  /** Why the files cannot show (agent-fs unreachable, no key), when that is the case. */
  problem: string | null;
  orgId: string | null;
  driveId: string | null;
  /** The folder of the key in the shared drive (`/<key>`). */
  folder: string;
}

/**
 * The files under a group key in the shared drive (drive path = key). It
 * mints this browser's agent-fs key when there is none (step-2). A folder
 * that does not exist yet lists as no files.
 */
export function useGroupFiles(groupKey: string | null): GroupFiles {
  const fs = useAgentFs();
  const access = useAgentFsAccess();
  const auto = useAutoConnect({ enabled: groupKey !== null });
  const folder = groupDrivePath(groupKey ?? "");
  const drive = fs.orgId && fs.driveId ? { orgId: fs.orgId, driveId: fs.driveId } : null;
  const lsQuery = agentFsLsQuery(access, {
    orgId: drive?.orgId ?? "",
    driveId: drive?.driveId ?? "",
    path: folder,
  });
  const ls = useQuery({
    ...lsQuery,
    enabled: lsQuery.enabled !== false && drive !== null && groupKey !== null,
  });
  const off = fs.state === "disabled";
  // A key that cannot be minted settles as a problem, never as a wait.
  const connecting =
    fs.state === "loading" ||
    ((fs.state === "needs-connect" || fs.state === "invalid-key") &&
      (auto.running || auto.outcome === null || auto.outcome.kind === "connected"));
  let problem: string | null = null;
  if (!off && !connecting) {
    if (fs.state === "unreachable") problem = "Files cannot reach agent-fs right now.";
    else if (fs.state !== "ready") problem = "This browser has no Files key yet.";
    else if (!drive) problem = "No shared drive is set for this swarm.";
  }
  const files = useMemo((): LsEntry[] | undefined => {
    if (!groupKey) return undefined;
    if (off || problem) return [];
    if (connecting) return undefined;
    // A folder that does not exist yet fails `ls`: no files.
    if (ls.isError) return [];
    return ls.data ? outputFiles(ls.data.entries) : undefined;
  }, [groupKey, off, problem, connecting, ls.isError, ls.data]);
  return {
    files,
    off,
    problem,
    orgId: drive?.orgId ?? null,
    driveId: drive?.driveId ?? null,
    folder,
  };
}

/**
 * Whether `view` gets an Overview tab: a user group with a schedule or a
 * file under its key. `pending` while that is not known yet.
 */
export function useOverviewQualification(view: string | null): boolean | "pending" {
  const groupKey = canHaveOverview(view) ? view : null;
  const { schedules, isError } = useGroupSchedules(groupKey);
  const { files } = useGroupFiles(groupKey);
  if (!groupKey) return false;
  return overviewQualifies({
    schedules: isError ? 0 : schedules?.length,
    files: files?.length,
  });
}
