/**
 * The pinned Overview tab of a use-case group (step-10, mockup
 * `mockups/post-onboarding/r3-overview.html`). It answers three questions
 * at a glance: when the use case runs next and what it does, what it
 * produced, and how to talk to the Lead about it.
 *
 * Layout: the group's title row, the next-run bar, then two columns. Left:
 * Schedules, then Outputs. Right: the selected file's preview, then Ask the
 * Lead. Below `lg` it is one column: next run, outputs, preview, schedules,
 * Lead.
 */

import { useState } from "react";
import { useSessionTree } from "@/api/hooks/use-session-tree";
import { useUsers } from "@/api/hooks/use-users";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import type { DrivePath } from "@/lib/comb/paths";
import { groupCrumb } from "@/lib/session-groups";
import { userName } from "@/lib/sessions-v2";
import { cn } from "@/lib/utils";
import { GroupCrumbIcon } from "../group-crumb-icon";
import { GroupTabStar } from "../group-tab-star";
import { useMyGroups } from "../use-my-groups";
import { AskLeadWidget } from "./ask-lead-widget";
import { FilePreview } from "./file-preview";
import { NextRunBar } from "./next-run-bar";
import { OutputsWidget } from "./outputs-widget";
import { SchedulesWidget } from "./schedules-widget";
import { useGroupFiles, useGroupSchedules } from "./use-overview-data";

export function OverviewTab({
  view,
  onOpen,
  onOpenList,
  className,
}: {
  /** The group key (`?view=`). */
  view: string;
  /** Open a session in a tab next to this one. */
  onOpen: (rootTaskId: string) => void;
  /** Show the session list (the "needs you" chip). */
  onOpenList: () => void;
  /** Replaces the outer padding (the phone screen). */
  className?: string;
}) {
  const { userId } = useCurrentUser();
  const me = userId ?? null;
  const { data: users } = useUsers();
  const tree = useSessionTree().data;
  const counts = tree?.groups.find((group) => group.key === view);
  const title = groupCrumb(view, me, (id) => userName(users, id), tree?.labels ?? {});
  const { schedules } = useGroupSchedules(view);
  const files = useGroupFiles(view);
  const { writeBlock } = useMyGroups(me);
  const now = useMinuteClock();
  // The previewed file: the one picked, else the newest.
  const [picked, setPicked] = useState<string | null>(null);
  const pickedStillThere = files.files?.some((entry) => `${files.folder}${entry.name}` === picked);
  const newest = files.files?.[0];
  const selectedPath = pickedStillThere ? picked : newest ? `${files.folder}${newest.name}` : null;
  const selected: DrivePath | null =
    selectedPath && files.orgId && files.driveId
      ? { orgId: files.orgId, driveId: files.driveId, path: selectedPath }
      : null;
  const showOutputs = !files.off;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pt-4 pb-5 [scrollbar-gutter:stable]",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        <h2 className="flex min-w-0 items-center gap-1.5 text-base font-semibold">
          <GroupCrumbIcon
            groupKey={view}
            noGroup={false}
            className="size-4 text-muted-foreground"
          />
          <span className="truncate">{title}</span>
          <span className="font-mono text-xs font-normal tabular-nums text-muted-foreground">
            {counts?.total ?? ""}
          </span>
        </h2>
        <GroupTabStar groupKey={view} />
        {counts?.needsYou ? (
          <button
            type="button"
            onClick={onOpenList}
            className="ml-1 shrink-0 rounded-full border border-status-active/40 bg-status-active/15 px-2 py-0.5 text-xs font-medium text-status-active-strong hover:bg-status-active/25"
          >
            {counts.needsYou} needs you ›
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="hidden truncate font-mono text-xs text-muted-foreground md:block">
          {view}
        </span>
      </div>

      {schedules && schedules.length > 0 ? (
        <NextRunBar groupKey={view} schedules={schedules} now={now} onOpen={onOpen} />
      ) : null}

      <div className="flex min-w-0 flex-col gap-3 lg:grid lg:grid-cols-2 lg:items-start">
        <div className="flex min-w-0 flex-col gap-3 max-lg:contents">
          {schedules && schedules.length > 0 ? (
            <div className="max-lg:order-3">
              <SchedulesWidget groupKey={view} schedules={schedules} now={now} />
            </div>
          ) : null}
          {showOutputs ? (
            <div className="max-lg:order-1">
              <OutputsWidget
                groupKey={view}
                data={files}
                selected={selectedPath}
                onSelect={setPicked}
                now={now}
              />
            </div>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-3 max-lg:contents">
          {selected ? (
            <div className="max-lg:order-2">
              <FilePreview groupKey={view} file={selected} now={now} onOpen={onOpen} />
            </div>
          ) : null}
          <div className="max-lg:order-4">
            <AskLeadWidget
              groupKey={view}
              file={selectedPath}
              now={now}
              onOpen={onOpen}
              writeBlock={writeBlock(view)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
