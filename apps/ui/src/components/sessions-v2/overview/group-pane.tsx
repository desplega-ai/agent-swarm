/**
 * Which face the group tab shows (step-10): the pinned Overview or the
 * session list, from `?tab=` and whether the group qualifies.
 */

import { Skeleton } from "@/components/ui/skeleton";
import type { GroupPane } from "@/lib/sessions-v2";
import { resolveGroupPane } from "@/lib/use-case-overview";
import { useOverviewQualification } from "./use-overview-data";

export function useGroupPane(
  view: string | null,
  param: GroupPane | null,
): { qualifies: boolean; pane: GroupPane | "pending" } {
  const qualifies = useOverviewQualification(view);
  return { qualifies: qualifies === true, pane: resolveGroupPane(param, qualifies) };
}

/** The group tab body while it is not known yet whether the group has an Overview. */
export function GroupPanePending() {
  return (
    <div aria-busy className="flex min-h-0 flex-1 flex-col gap-3 px-5 pt-4 pb-3">
      <span className="sr-only">Loading the group…</span>
      <Skeleton className="h-6 w-56" />
      <Skeleton className="h-12 w-full" />
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
